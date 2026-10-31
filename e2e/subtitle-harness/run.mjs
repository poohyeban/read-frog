import { existsSync } from "node:fs"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "@playwright/test"
import react from "@vitejs/plugin-react"
import { build } from "vite"
import { serveBuild } from "../ui-harness/serve.mjs"
const source = resolve(process.argv[2] || ".")
const output = resolve(process.argv[3] || "docs/subtitle-upgrade/baseline")
const buildRoot = `${output}/browser-build`
const harness = resolve("e2e/subtitle-harness")
await mkdir(output, { recursive: true })
const substitute = {
  ...(!existsSync(
    `${source}/src/entrypoints/subtitles.content/ui/subtitles-sidebar/sections/transcript/list.tsx`,
  )
    ? {
        "@/entrypoints/subtitles.content/ui/subtitles-sidebar/sections/transcript/list":
          "fallback-list.tsx",
      }
    : {}),
  ...(process.env.BENCHMARK_KIND === "export"
    ? { "@/utils/subtitles/srt": "export-fixture.ts" }
    : {}),
  "#imports": "fixture.ts",
  "@/utils/config/storage": "fixture.ts",
  "@/utils/atoms/config": "fixture.ts",
  "@/utils/message": "fixture.ts",
  "@/utils/i18n": "fixture.ts",
  "@/entrypoints/background/config": "fixture.ts",
  "@/utils/subtitles/processor/translator": "model.ts",
  "@/utils/subtitles/processor/ai-segmentation": "model.ts",
}
await build({
  configFile: false,
  plugins: [
    {
      name: "controlled-subtitle-provider",
      enforce: "pre",
      resolveId(id, importer) {
        if (
          id === "./physical" &&
          importer?.endsWith("subtitle-harness/model.ts") &&
          !existsSync(`${source}/src/utils/request/resource-scheduler.ts`)
        )
          return resolve(harness, "physical-baseline.ts")
        if (
          id === "./config" &&
          (importer?.endsWith("background/translation-queues.ts") ||
            importer?.endsWith("background/subtitle-work.ts"))
        )
          return resolve(harness, "fixture.ts")
        if (
          id === "@/entrypoints/subtitles.content/ui/subtitles-sidebar/sections/transcript/list" &&
          !existsSync(
            `${source}/src/entrypoints/subtitles.content/ui/subtitles-sidebar/sections/transcript/list.tsx`,
          )
        )
          return resolve(harness, "fallback-list.tsx")
        if (
          id.endsWith("ui/subtitles-sidebar/sections") ||
          id.endsWith("ui/subtitles-settings-panel/views")
        )
          return resolve(harness, "fixture.ts")
        if (substitute[id]) return resolve(harness, substitute[id])
        return undefined
      },
    },
    react(),
  ],
  resolve: {
    alias: [
      ...Object.entries(substitute).map(([find, name]) => ({
        find,
        replacement: resolve(harness, name),
      })),
      {
        find: "@benchmark/baseline-queue",
        replacement: `${source}/src/utils/request/request-queue.ts`,
      },
      {
        find: "@benchmark/baseline-slots",
        replacement: `${source}/src/utils/request/execution-slots.ts`,
      },
      {
        find: "@benchmark/source-segmentation",
        replacement: `${source}/src/utils/subtitles/processor/ai-segmentation.ts`,
      },
      { find: "@benchmark/source-srt", replacement: `${source}/src/utils/subtitles/srt.ts` },
      { find: "@", replacement: `${source}/src` },
    ],
  },
  build: {
    outDir: buildRoot,
    emptyOutDir: true,
    lib: {
      entry: `${harness}/${process.env.BENCHMARK_KIND ? `${process.env.BENCHMARK_KIND}-entry` : "entry"}.tsx`,
      formats: ["es"],
      fileName: () => "benchmark.js",
    },
    minify: !process.env.BENCHMARK_PROFILE,
  },
  define: { "process.env.NODE_ENV": '"production"' },
})
await writeFile(
  `${buildRoot}/index.html`,
  '<div id="root"></div><script type="module" src="/benchmark.js"></script>',
)
const server = await serveBuild(buildRoot)
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--enable-precise-memory-info"],
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on("dialog", (dialog) => dialog.accept())
  page.on("pageerror", (error) => errors.push(error.message))
  const config = null
  await page.addInitScript((fixtureConfig) => {
    window.__config = fixtureConfig
  }, config)
  await page.addInitScript((mode) => {
    window.__benchmarkMode = mode
    let seed = 20261031
    Math.random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
  }, process.env.BENCHMARK_MODE ?? "dual")
  if (["continuity", "matrix", "lifecycle"].includes(process.env.BENCHMARK_KIND))
    await page.clock.install()
  await page.goto(`${server.url}/index.html`)
  await page.waitForFunction(() => window.runSubtitleBenchmark)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  const beforeMetrics = await cdp.send("Performance.getMetrics")
  if (process.env.BENCHMARK_PROFILE) {
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.start")
  }
  let finished = false
  const running = page
    .evaluate(() => window.runSubtitleBenchmark())
    .finally(() => {
      finished = true
    })
  if (["continuity", "matrix", "lifecycle"].includes(process.env.BENCHMARK_KIND)) {
    for (let step = 0; step < 10000; step++) {
      if (finished) break
      await page.clock.runFor(process.env.BENCHMARK_KIND === "matrix" ? 60000 : 10000)
    }
  }
  const results = await running
  if (process.env.BENCHMARK_PROFILE) {
    const { profile } = await cdp.send("Profiler.stop")
    await writeFile(`${output}/cpu-profile.json`, JSON.stringify(profile))
  }
  const system = await browser.newBrowserCDPSession()
  const processes = await system.send("SystemInfo.getProcessInfo")
  const memory = await Promise.all(
    processes.processInfo
      .filter((p) => p.type === "renderer")
      .map(async (p) => {
        const status = await readFile(`/proc/${p.id}/status`, "utf8").catch(() => "")
        return {
          type: p.type,
          peakRssKiB: Number(status.match(/VmHWM:\s+(\d+)/)?.[1] ?? 0),
          rssKiB: Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0),
        }
      }),
  )
  await writeFile(
    `${output}/raw.json`,
    JSON.stringify(
      {
        environment: {
          source,
          browser: browser.version(),
          node: process.version,
          kind: "real Chromium; bundled actual scheduler/coordinator/atoms; deterministic local Provider; NOT native MV3",
        },
        errors,
        browserMetrics: {
          before: beforeMetrics.metrics,
          after: (await cdp.send("Performance.getMetrics")).metrics,
        },
        rendererCpuSeconds: processes.processInfo
          .filter((p) => p.type === "renderer")
          .reduce((n, p) => n + p.cpuTime, 0),
        rendererMemory: memory,
        ...results,
      },
      null,
      2,
    ),
  )
  const failures = Object.entries(results.checks ?? {})
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name)
  for (const [index, row] of (results.samples ?? []).entries()) {
    if ((row.afterStopRequests ?? 0) !== 0) failures.push(`sample ${index}: requests after stop`)
    if (row.peakActive > row.concurrency) failures.push(`sample ${index}: concurrency exceeded`)
    if (
      row.resources &&
      [row.resources.active, row.resources.queued, row.resources.timers].some(
        (value) => (value ?? 0) !== 0,
      )
    )
      failures.push(`sample ${index}: resource leak`)
  }
  for (const scale of results.scales ?? [])
    for (const row of scale.samples ?? []) {
      if (
        row.result &&
        (!row.result.valid || row.result.count !== scale.size || row.result.unique !== scale.size)
      )
        failures.push(`export ${scale.size}: incomplete`)
    }
  if (errors.length || failures.length) throw new Error(JSON.stringify({ errors, failures }))
  console.log(
    output,
    errors,
    (results.scales ?? []).map((r) => ({ size: r.size, commits: r.sameCueCommits })),
  )
} finally {
  await browser.close()
  server.close()
}

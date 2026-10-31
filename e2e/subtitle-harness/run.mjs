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
  "@/utils/host/translate/execute-translate": "queue-model.ts",
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
    minify: true,
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
  page.on("pageerror", (error) => errors.push(error.message))
  const config = JSON.parse(
    await readFile("/tmp/read-frog-ui-fixture/config.json", "utf8").catch(() => "null"),
  )
  await page.addInitScript((fixtureConfig) => {
    window.__config = fixtureConfig
  }, config)
  await page.addInitScript((mode) => {
    window.__benchmarkMode = mode
  }, process.env.BENCHMARK_MODE ?? "dual")
  if (process.env.BENCHMARK_KIND === "continuity") await page.clock.install()
  await page.goto(`${server.url}/index.html`)
  await page.waitForFunction(() => window.runSubtitleBenchmark)
  let finished = false
  const running = page
    .evaluate(() => window.runSubtitleBenchmark())
    .finally(() => {
      finished = true
    })
  if (process.env.BENCHMARK_KIND === "continuity") {
    for (let step = 0; step < 10000; step++) {
      if (finished) break
      await page.clock.runFor(10000)
    }
  }
  const results = await running
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
        rendererMemory: memory,
        ...results,
      },
      null,
      2,
    ),
  )
  console.log(
    output,
    errors,
    (results.scales ?? []).map((r) => ({ size: r.size, commits: r.sameCueCommits })),
  )
} finally {
  await browser.close()
  server.close()
}

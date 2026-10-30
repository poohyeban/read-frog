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
  "#imports": "fixture.ts",
  "@/utils/config/storage": "fixture.ts",
  "@/utils/atoms/config": "fixture.ts",
  "@/utils/message": "fixture.ts",
  "@/utils/i18n": "fixture.ts",
  "@/utils/subtitles/processor/translator": "model.ts",
  "@/utils/subtitles/processor/ai-segmentation": "model.ts",
}
await build({
  configFile: false,
  plugins: [
    {
      name: "controlled-subtitle-provider",
      enforce: "pre",
      resolveId(id) {
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
      { find: "@", replacement: `${source}/src` },
    ],
  },
  build: {
    outDir: buildRoot,
    emptyOutDir: true,
    lib: { entry: `${harness}/entry.tsx`, formats: ["es"], fileName: () => "benchmark.js" },
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
  const config = JSON.parse(await readFile("/tmp/read-frog-ui-fixture/config.json", "utf8"))
  await page.addInitScript((fixtureConfig) => {
    window.__config = fixtureConfig
  }, config)
  await page.goto(`${server.url}/index.html`)
  await page.waitForFunction(() => window.runSubtitleBenchmark)
  const results = await page.evaluate(() => window.runSubtitleBenchmark())
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
        ...results,
      },
      null,
      2,
    ),
  )
  console.log(
    output,
    errors,
    results.scales.map((r) => ({ size: r.size, commits: r.sameCueCommits })),
  )
} finally {
  await browser.close()
  server.close()
}

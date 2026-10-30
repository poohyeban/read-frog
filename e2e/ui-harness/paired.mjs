import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "@playwright/test"
import { installBrowserAPI } from "./browser-api.mjs"
import { serveBuild } from "./serve.mjs"
const roots = { before: resolve(process.argv[2]), after: resolve(process.argv[3]) }
const output = resolve(process.argv[4] || "docs/ui-performance/paired")
await mkdir(output, { recursive: true })
const config = JSON.parse(await readFile("/tmp/read-frog-ui-fixture/config.json", "utf8"))
const locales = (process.env.UI_LOCALES || "en").split(",")
const delays = (process.env.UI_DELAYS || "10,120").split(",").map(Number)
const servers = { before: await serveBuild(roots.before), after: await serveBuild(roots.after) }
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
})
const samples = Number(process.env.UI_SAMPLES || 30)
const contexts = new Map()
const results = []
try {
  for (let sample = 0; sample < samples; sample++)
    for (const locale of locales)
      for (const cache of ["cold", "repeat"])
        for (const backgroundDelay of delays)
          for (const version of sample % 2 ? ["after", "before"] : ["before", "after"]) {
            const key = `${version}-${locale}-${backgroundDelay}`
            let context = cache === "repeat" ? contexts.get(key) : undefined
            if (!context) {
              context = await browser.newContext({
                viewport: { width: 320, height: 700 },
                deviceScaleFactor: 1,
                reducedMotion: "reduce",
              })
              if (cache === "repeat") contexts.set(key, context)
            }
            const page = await context.newPage()
            await page.addInitScript(installBrowserAPI, {
              config: { ...config, uiLanguage: locale },
              locale,
              backgroundDelay,
            })
            const cdp = await context.newCDPSession(page)
            await cdp.send("Performance.enable")
            await page.goto(`${servers[version].url}/popup.html`)
            await page.waitForFunction(
              () => window.__uiTrace.interactive && window.__uiTrace.meaningfulPaint,
            )
            await page.evaluate(() => document.fonts.ready)
            const trace = await page.evaluate(() => ({
              ...window.__uiTrace,
              paint: performance
                .getEntriesByType("paint")
                .map((e) => ({ name: e.name, start: e.startTime })),
              resources: performance.getEntriesByType("resource").map((e) => ({
                name: e.name.split("/").at(-1),
                duration: e.duration,
                start: e.startTime,
                end: e.responseEnd,
                bytes: e.decodedBodySize,
              })),
            }))
            const metrics = (await cdp.send("Performance.getMetrics")).metrics
            results.push({
              version,
              locale,
              cache,
              backgroundDelay,
              sample,
              ...trace,
              metrics: Object.fromEntries(
                metrics
                  .filter((m) =>
                    [
                      "ScriptDuration",
                      "TaskDuration",
                      "JSHeapUsedSize",
                      "Nodes",
                      "LayoutDuration",
                    ].includes(m.name),
                  )
                  .map((m) => [m.name, m.value]),
              ),
            })
            await page.close()
            if (context.pages().length) throw new Error("Popup page leaked")
            if (cache === "cold") await context.close()
            if (sample === samples - 1) console.log(version, cache, backgroundDelay, "complete")
          }
} finally {
  for (const context of contexts.values()) await context.close()
  await browser.close()
  for (const server of Object.values(servers)) server.close()
}
const p = (a, q) => a.sort((x, y) => x - y)[Math.ceil(a.length * q) - 1]
const summary = []
for (const version of ["before", "after"])
  for (const locale of locales)
    for (const cache of ["cold", "repeat"])
      for (const backgroundDelay of delays) {
        const rows = results.filter(
          (r) =>
            r.version === version &&
            r.locale === locale &&
            r.cache === cache &&
            r.backgroundDelay === backgroundDelay,
        )
        const metrics = {}
        for (const key of ["meaningful", "meaningfulPaint", "interactive"])
          metrics[key] = {
            p50: p(
              rows.map((r) => r[key]),
              0.5,
            ),
            p95: p(
              rows.map((r) => r[key]),
              0.95,
            ),
          }
        for (const key of ["ScriptDuration", "TaskDuration", "JSHeapUsedSize"])
          metrics[key] = {
            p50: p(
              rows.map((r) => r.metrics[key]),
              0.5,
            ),
            p95: p(
              rows.map((r) => r.metrics[key]),
              0.95,
            ),
          }
        summary.push({ version, locale, cache, backgroundDelay, samples: rows.length, metrics })
      }
await writeFile(
  `${output}/raw.json`,
  JSON.stringify(
    {
      environment: {
        browser: browser.version(),
        node: process.version,
        roots,
        method: `${samples} matched samples per condition/version, ${samples * locales.length * delays.length * 4} loads; alternate AB/BA by sample; scenarios interleaved; controlled extension API delays; no outlier removal; cold means new context, not OS cold; every page closed before next load`,
      },
      results,
    },
    null,
    2,
  ),
)
await writeFile(`${output}/summary.json`, JSON.stringify(summary, null, 2))
console.log(summary)

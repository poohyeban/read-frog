import { readFile, writeFile, mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve, extname } from "node:path"
import { chromium } from "@playwright/test"
import { installBrowserAPI } from "./browser-api.mjs"
const root = resolve(process.argv[2] || ".output/chrome-mv3")
const output = resolve(process.argv[3] || "docs/ui-performance/baseline")
const samples = Number(process.env.UI_SAMPLES || 30)
await mkdir(output, { recursive: true })
const config = JSON.parse(await readFile("/tmp/read-frog-ui-fixture/config.json", "utf8"))
config.uiLanguage = "en"
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
}
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, `.${new URL(req.url, "http://localhost").pathname}`)
    if (!path.startsWith(`${root}/`)) throw new Error("path")
    const data = await readFile(path)
    res.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
      "Cache-Control": "public, max-age=3600",
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end()
  }
})
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const url = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
})
const results = []
try {
  for (const cache of ["cold", "repeat"])
    for (const backgroundDelay of [10, 120]) {
      let context
      for (let sample = 0; sample < samples; sample++) {
        if (!context || cache === "cold")
          context = await browser.newContext({
            viewport: { width: 320, height: 700 },
            deviceScaleFactor: 1,
            reducedMotion: "reduce",
          })
        const page = await context.newPage()
        const errors = []
        page.on("pageerror", (err) => errors.push(err.message))
        await page.addInitScript(installBrowserAPI, { config, backgroundDelay })
        const cdp = await context.newCDPSession(page)
        await cdp.send("Performance.enable")
        await page.goto(`${url}/popup.html`)
        try {
          await page.waitForFunction(
            () => window.__uiTrace?.interactive && window.__uiTrace?.meaningfulPaint,
            {},
            { timeout: 15000 },
          )
        } catch (error) {
          await page.screenshot({ path: `${output}/failure.png` })
          console.error(
            errors,
            await page.evaluate(() => ({ trace: window.__uiTrace, body: document.body.innerText })),
          )
          throw error
        }
        await page.evaluate(() => document.fonts.ready)
        const data = await page.evaluate(() => ({
          ...window.__uiTrace,
          paint: performance
            .getEntriesByType("paint")
            .map((e) => ({ name: e.name, start: e.startTime })),
          resources: performance.getEntriesByType("resource").map((e) => ({
            name: e.name.split("/").at(-1),
            duration: e.duration,
            bytes: e.decodedBodySize,
          })),
          height: document.body.scrollHeight,
          overflow: document.documentElement.scrollWidth > innerWidth,
        }))
        const metrics = (await cdp.send("Performance.getMetrics")).metrics
        results.push({
          cache,
          backgroundDelay,
          sample,
          ...data,
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
        if (sample === 0) {
          await page.screenshot({
            path: `${output}/${cache}-${backgroundDelay}.png`,
            fullPage: true,
          })
        }
        await page.close()
        if (cache === "cold") {
          await context.close()
          context = undefined
        }
      }
      await context?.close()
      console.log(cache, backgroundDelay, "complete")
    }
} finally {
  await browser.close()
  server.close()
}
const percentile = (values, p) => values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
const summary = []
for (const cache of ["cold", "repeat"])
  for (const backgroundDelay of [10, 120]) {
    const rows = results.filter((r) => r.cache === cache && r.backgroundDelay === backgroundDelay)
    const metrics = {}
    for (const key of ["meaningful", "meaningfulPaint", "interactive"])
      metrics[key] = {
        p50: percentile(
          rows.map((r) => r[key]),
          0.5,
        ),
        p95: percentile(
          rows.map((r) => r[key]),
          0.95,
        ),
      }
    for (const key of ["ScriptDuration", "TaskDuration", "JSHeapUsedSize"])
      metrics[key] = {
        p50: percentile(
          rows.map((r) => r.metrics[key]),
          0.5,
        ),
        p95: percentile(
          rows.map((r) => r.metrics[key]),
          0.95,
        ),
      }
    summary.push({ cache, backgroundDelay, samples: rows.length, metrics })
  }
await writeFile(
  `${output}/raw.json`,
  JSON.stringify(
    {
      environment: {
        browser: browser.version(),
        node: process.version,
        root,
        note: "Production HTML/JS over HTTP; simulated extension APIs, NOT real MV3 SW timings",
      },
      results,
    },
    null,
    2,
  ),
)
await writeFile(`${output}/summary.json`, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))

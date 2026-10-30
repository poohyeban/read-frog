import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium, expect } from "@playwright/test"
import { installBrowserAPI } from "./browser-api.mjs"
import { serveBuild } from "./serve.mjs"
const root = resolve(process.argv[2])
const output = resolve(process.argv[3])
await mkdir(output, { recursive: true })
const config = JSON.parse(await readFile("/tmp/read-frog-ui-fixture/config.json", "utf8"))
config.uiLanguage = "en"
const samples = Number(process.env.UI_SAMPLES || 30)
const server = await serveBuild(root)
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
})
const results = []
try {
  for (const entry of ["options", "translation-hub"])
    for (let sample = 0; sample < samples; sample++) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        reducedMotion: "reduce",
      })
      const page = await context.newPage()
      const errors = []
      page.on("pageerror", (error) => errors.push(error.message))
      await context.route("**/*", (route) =>
        route.request().url().startsWith(server.url) ? route.continue() : route.abort(),
      )
      await page.addInitScript(installBrowserAPI, { config })
      await page.addInitScript(
        ({ entry: pageEntry }) => {
          const observer = new MutationObserver(() => {
            const ready =
              pageEntry === "translation-hub"
                ? document.querySelector("textarea")
                : [...document.querySelectorAll("h1")].some(
                    (h) => h.textContent === "API Providers",
                  ) && document.querySelector('input[type="password"]')
            if (ready && !window.__pageReady) {
              window.__pageReady = performance.now()
              observer.disconnect()
            }
          })
          observer.observe(document, { childList: true, subtree: true, attributes: true })
        },
        { entry },
      )
      const cdp = await context.newCDPSession(page)
      await cdp.send("Performance.enable")
      await page.goto(`${server.url}/${entry}.html`)
      try {
        await page.waitForFunction(() => window.__pageReady, {}, { timeout: 15000 })
      } catch (e) {
        console.error(errors, await page.locator("body").innerText())
        throw e
      }
      const initial = await page.evaluate(() => ({
        ready: window.__pageReady,
        resources: performance
          .getEntriesByType("resource")
          .map((r) => ({ name: r.name.split("/").at(-1), bytes: r.decodedBodySize })),
        heap: performance.memory?.usedJSHeapSize,
      }))
      const metrics = (await cdp.send("Performance.getMetrics")).metrics
      const data = {
        entry,
        sample,
        initial,
        metrics: Object.fromEntries(
          metrics
            .filter((m) => ["ScriptDuration", "TaskDuration", "JSHeapUsedSize"].includes(m.name))
            .map((m) => [m.name, m.value]),
        ),
        errors,
      }
      if (entry === "options") {
        const start = await page.evaluate(() => {
          const now = performance.now()
          location.hash = "/page-translation/custom-css"
          return now
        })
        await page.locator(".cm-editor").first().waitFor()
        data.editorRoute = await page.evaluate((startedAt) => performance.now() - startedAt, start)
        if (sample === 0)
          await page.screenshot({ path: `${output}/options-editor.png`, fullPage: true })
        const back = await page.evaluate(() => {
          const now = performance.now()
          location.hash = "/api-providers"
          return now
        })
        await page.getByRole("heading", { name: "API Providers", exact: true }).waitFor()
        data.backRoute = await page.evaluate((startedAt) => performance.now() - startedAt, back)
        // Opening and closing advanced options must preserve raw JSON drafts and autosave registration.
        if (sample === 0) {
          const advanced = page.getByText("Advanced options", { exact: true })
          await advanced.click()
          await page.locator(".cm-editor").first().waitFor()
          data.advancedEditors = await page.locator(".cm-editor").count()
          await advanced.click()
          await advanced.click()
          expect(await page.locator(".cm-editor").count()).toBe(data.advancedEditors)
        }
      }
      expect(errors).toEqual([])
      results.push(data)
      await context.close()
      if (sample === samples - 1) console.log(entry, "complete")
    }
} finally {
  await browser.close()
  server.close()
  await writeFile(
    `${output}/raw.json`,
    JSON.stringify(
      {
        note: "Production extension pages over HTTP with API fixtures; 30 cold browser contexts per entry by default.",
        results,
      },
      null,
      2,
    ),
  )
}
const p = (a, q) => a.sort((x, y) => x - y)[Math.ceil(a.length * q) - 1]
const summary = []
for (const entry of ["options", "translation-hub"]) {
  const rows = results.filter((r) => r.entry === entry)
  const stats = {}
  for (const key of ["ready", "editorRoute", "backRoute"]) {
    const values = rows
      .map((r) => (key === "ready" ? r.initial.ready : r[key]))
      .filter((v) => typeof v === "number")
    if (values.length) stats[key] = { p50: p(values, 0.5), p95: p(values, 0.95) }
  }
  summary.push({ entry, samples: rows.length, stats })
}
await writeFile(`${output}/summary.json`, JSON.stringify(summary, null, 2))
console.log(summary)

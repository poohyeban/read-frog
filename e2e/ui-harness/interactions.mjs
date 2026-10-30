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
const server = await serveBuild(root)
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
})
const rows = []
async function measure(page, trigger, readySelector) {
  await page.evaluate(
    ({ trigger: triggerSelector, readySelector: contentSelector }) => {
      window.__interactionStart = performance.now()
      window.__interactionEnd = undefined
      const observer = new MutationObserver(() => {
        if (document.querySelector(contentSelector)) {
          window.__interactionEnd = performance.now()
          observer.disconnect()
        }
      })
      observer.observe(document, { childList: true, subtree: true, attributes: true })
      document.querySelector(triggerSelector).click()
    },
    { trigger, readySelector },
  )
  await page.waitForFunction(() => window.__interactionEnd)
  return page.evaluate(() => window.__interactionEnd - window.__interactionStart)
}
try {
  for (let sample = 0; sample < Number(process.env.UI_SAMPLES || 30); sample++) {
    const context = await browser.newContext({
      viewport: { width: 320, height: 600 },
      reducedMotion: "reduce",
    })
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.addInitScript(installBrowserAPI, { config })
    await page.goto(`${server.url}/popup.html`)
    await page.waitForFunction(() => window.__uiTrace.interactive)
    await page.evaluate(() => document.fonts.ready)
    const drawer = await measure(
      page,
      '[aria-label="Open provider settings"]',
      '[data-slot="drawer-content"] [data-slot="select-trigger"]',
    )
    await page.keyboard.press("Escape")
    await expect(page.getByRole("button", { name: "Open provider settings" })).toBeFocused()
    const language = await measure(
      page,
      '[aria-label="Source"]',
      '[role="listbox"] [role="option"]',
    )
    await page.keyboard.press("Escape")
    const translationFeedback = await page.evaluate(
      () =>
        new Promise((done) => {
          const control =
            document.querySelector("[data-popup-translate]") ||
            [...document.querySelectorAll("button")].find((button) =>
              /^Translate/.test(button.textContent.trim()),
            )
          const initial = control.textContent
          const start = performance.now()
          const observer = new MutationObserver(() => {
            if (control.textContent !== initial) {
              observer.disconnect()
              done(performance.now() - start)
            }
          })
          observer.observe(control, { childList: true, subtree: true, characterData: true })
          control.click()
        }),
    )
    const feedback = await page.evaluate(
      () =>
        new Promise((done) => {
          const control = [...document.querySelectorAll('[role="switch"]')].at(-1)
          const initial = control.getAttribute("aria-checked")
          const start = performance.now()
          const observer = new MutationObserver(() => {
            if (control.getAttribute("aria-checked") !== initial) {
              observer.disconnect()
              done(performance.now() - start)
            }
          })
          observer.observe(control, { attributes: true })
          control.click()
        }),
    )
    expect(errors).toEqual([])
    rows.push({ sample, drawer, language, feedback, translationFeedback })
    await context.close()
  }
} finally {
  await browser.close()
  server.close()
}
const p = (values, q) => values.sort((a, b) => a - b)[Math.ceil(values.length * q) - 1]
const summary = Object.fromEntries(
  ["drawer", "language", "feedback", "translationFeedback"].map((key) => [
    key,
    {
      p50: p(
        rows.map((r) => r[key]),
        0.5,
      ),
      p95: p(
        rows.map((r) => r[key]),
        0.95,
      ),
    },
  ]),
)
await writeFile(
  `${output}/results.json`,
  JSON.stringify(
    {
      note: "Production builds; cold contexts; DOM click dispatch to usable content/feedback; drawer intentionally has NO hover/focus preload. Excludes Playwright auto-wait and physical display presentation.",
      samples: rows.length,
      summary,
      rows,
    },
    null,
    2,
  ),
)
console.log(summary)

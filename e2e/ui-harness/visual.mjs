import { readFile, mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve, extname } from "node:path"
import { chromium, expect } from "@playwright/test"
import { installBrowserAPI } from "./browser-api.mjs"
const root = resolve(process.argv[2] || ".output/chrome-mv3")
const output = resolve(process.argv[3] || "docs/ui-performance/visual-after")
await mkdir(output, { recursive: true })
const base = JSON.parse(await readFile("/tmp/read-frog-ui-fixture/config.json", "utf8"))
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
}
const server = createServer(async (req, res) => {
  try {
    const file = resolve(root, `.${new URL(req.url, "http://localhost").pathname}`)
    if (!file.startsWith(`${root}/`)) throw new Error("path")
    const bytes = await readFile(file)
    res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" })
    res.end(bytes)
  } catch {
    res.writeHead(404)
    res.end()
  }
})
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
})
const results = []
const cases = [
  ...["light", "dark"].flatMap((theme) =>
    ["en", "zh-CN"].map((locale) => ({ name: `${theme}-${locale}`, theme, locale })),
  ),
  { name: "long-labels", long: true },
  { name: "multiple-providers", multiple: true },
  { name: "no-providers", empty: true },
  { name: "restricted", tabUrl: "chrome://settings/" },
  { name: "no-tab", tabUrl: null },
  { name: "message-error", failure: "message" },
  { name: "message-timeout", failure: "hang" },
  { name: "tabs-error", failure: "tabs" },
  { name: "loading", backgroundDelay: 1200, loading: true },
  { name: "scale-125", scale: 1.25 },
  { name: "scale-150", scale: 1.5 },
  ...["az", "es", "ja", "ko", "ru", "tr", "vi", "zh-TW"].map((locale) => ({
    name: `locale-${locale}`,
    locale,
  })),
]
try {
  for (const item of cases) {
    const config = structuredClone(base)
    config.uiLanguage = item.locale || "en"
    if (item.long) {
      config.language.sourceCode = "ckb"
      config.language.targetCode = "yue"
    }
    if (item.multiple) {
      config.pageTranslation.providerId = config.providersConfig[1].id
      config.inputTranslation.providerId = config.providersConfig[2].id
      config.providersConfig[1].name = "Research translation provider with a very long name"
    }
    if (item.empty)
      config.providersConfig.forEach((provider) => {
        provider.enabled = false
      })
    const context = await browser.newContext({
      viewport: { width: 320, height: 600 },
      deviceScaleFactor: item.scale || 1,
      reducedMotion: "reduce",
    })
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addInitScript(installBrowserAPI, {
      config,
      theme: item.theme || "dark",
      locale: item.locale || "en",
      backgroundDelay: item.backgroundDelay || 10,
      tabUrl: item.tabUrl === undefined ? "https://example.com/article" : item.tabUrl,
      failure: item.failure,
    })
    await page.goto(`http://127.0.0.1:${server.address().port}/popup.html`)
    await page.waitForFunction(() => window.__uiTrace.meaningful)
    if (!item.loading)
      await page.waitForFunction(
        () => {
          const b = document.querySelector("[data-popup-translate]")
          return !b || b.getAttribute("aria-busy") === "false"
        },
        {},
        { timeout: 5000 },
      )
    await page.evaluate(() => document.fonts.ready)
    const state = await page.evaluate(() => ({
      height: document.querySelector("#root").scrollHeight,
      overflow: document.documentElement.scrollWidth > innerWidth,
      translate: document.querySelector("[data-popup-translate]")?.textContent,
      disabled: document.querySelector("[data-popup-translate]")?.disabled,
      theme: document.documentElement.className,
      trace: window.__uiTrace,
    }))
    expect(state.overflow, item.name).toBe(false)
    expect(errors, item.name).toEqual([])
    if (item.loading || item.name === "restricted") expect(state.disabled, item.name).toBe(true)
    await page.locator("#root").screenshot({ path: `${output}/${item.name}.png` })
    results.push({ name: item.name, ...state })
    await context.close()
    console.log(item.name, "OK", state.height)
  }
  // Actual controls: persistent config writes, translation acknowledgement, keyboard/focus.
  const context = await browser.newContext({
    viewport: { width: 320, height: 600 },
    reducedMotion: "reduce",
  })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.addInitScript(installBrowserAPI, { config: { ...base, uiLanguage: "en" } })
  await page.goto(`http://127.0.0.1:${server.address().port}/popup.html`)
  await page.waitForFunction(() => window.__uiTrace.interactive)
  const timings = {}
  const translate = page.locator("[data-popup-translate]")
  if (await translate.count()) {
    const start = performance.now()
    await translate.click()
    await expect(translate).toHaveText(/Show Original/)
    timings.translate = performance.now() - start
    await translate.click()
    await expect(translate).toHaveText(/Translate/)
  }
  const providers = page.getByRole("button", { name: "Open provider settings" })
  let start = performance.now()
  await providers.click()
  await page.locator('[data-slot="drawer-content"] [data-slot="select-trigger"]').first().waitFor()
  timings.firstDrawer = performance.now() - start
  await page
    .locator('[data-slot="drawer-content"]')
    .screenshot({ path: `${output}/providers-open.png` })
  await page.keyboard.press("Escape")
  await expect(providers).toBeFocused()
  const source = page.getByLabel("Source", { exact: true })
  await source.focus()
  start = performance.now()
  await source.press("Enter")
  await page.getByRole("combobox").last().waitFor()
  timings.firstLanguageMenu = performance.now() - start
  await page.keyboard.press("Escape")
  await expect(source).toBeFocused()
  const ai = page.getByRole("switch", { name: "AI Smart Context" })
  if (await ai.count()) {
    const before = await ai.getAttribute("aria-checked")
    start = performance.now()
    await ai.press("Space")
    await expect(ai).toHaveAttribute("aria-checked", before === "true" ? "false" : "true")
    timings.switchFeedback = performance.now() - start
    await page.waitForFunction(() => window.__uiTrace.calls.some((c) => c.name === "storage.set"))
  }
  await page.evaluate(() => {
    const config = structuredClone(window.__uiFixture.values.readFrogLiteConfig)
    config.uiLanguage = "zh-CN"
    window.__uiFixture.values.readFrogLiteConfig = config
    window.__uiFixture.changed.emit({ readFrogLiteConfig: { newValue: config } }, "local")
  })
  await expect(page.getByLabel("源语言", { exact: true })).toBeVisible()
  expect(errors).toEqual([])
  results.push({ name: "interactions", timings, errors })
  await context.close()
} finally {
  await browser.close()
  server.close()
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2))
}

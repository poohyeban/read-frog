import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium, expect } from "@playwright/test"
import { installBrowserAPI } from "./browser-api.mjs"
import { serveBuild } from "./serve.mjs"
const root = resolve(process.argv[2] || ".output/chrome-mv3")
const output = resolve(process.argv[3] || "docs/ui-performance/functional")
await mkdir(output, { recursive: true })
const config = JSON.parse(await readFile("/tmp/read-frog-ui-fixture/config.json", "utf8"))
config.uiLanguage = "en"
const server = await serveBuild(root)
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
})
const passed = []
try {
  const context = await browser.newContext({
    viewport: { width: 320, height: 426 },
    reducedMotion: "reduce",
  })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.addInitScript(installBrowserAPI, { config })
  await page.goto(`${server.url}/popup.html`)
  await page.waitForFunction(() => window.__uiTrace.interactive)
  const settled = async () => {
    await page.waitForFunction(() => {
      const calls = window.__uiTrace.calls
      return !calls.some((c) => c.name === "storage.set" && !c.end)
    })
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    )
  }
  const persisted = async (fn) => {
    await page.waitForFunction(fn)
    await settled()
  }
  await page.getByLabel("Target", { exact: true }).click()
  await page.getByPlaceholder("Search languages...").fill("Japanese")
  await page.getByRole("option").filter({ hasText: "Japanese" }).first().click()
  await persisted(() => window.__uiFixture.values.readFrogLiteConfig.language.targetCode === "jpn")
  passed.push("target language selection persists")
  await page.getByRole("button", { name: "Open provider settings" }).click()
  const provider = page.locator('[data-slot="drawer-content"] [data-slot="select-trigger"]').nth(2)
  await provider.click()
  await page.getByRole("option").filter({ hasText: "DeepSeek" }).first().click()
  await persisted(
    () =>
      window.__uiFixture.values.readFrogLiteConfig.pageTranslation.providerId ===
      "deepseek-default",
  )
  await page.keyboard.press("Escape")
  passed.push("feature provider assignment persists")
  const previousPrompt = await page.evaluate(
    () => window.__uiFixture.values.readFrogLiteConfig.pageTranslation.customPromptsConfig.promptId,
  )
  await page.getByRole("combobox", { name: "AI Translation Style" }).click()
  await page.getByRole("option").nth(1).click()
  await page.waitForFunction(
    (old) =>
      window.__uiFixture.values.readFrogLiteConfig.pageTranslation.customPromptsConfig.promptId !==
      old,
    previousPrompt,
  )
  await settled()
  passed.push("translation style persists")
  await page.getByRole("button", { name: "Click to switch to translation only" }).click()
  await persisted(
    () => window.__uiFixture.values.readFrogLiteConfig.pageTranslation.mode === "translationOnly",
  )
  passed.push("translation mode persists")
  const auto = page.getByRole("switch", { name: "Always translate this site" })
  await auto.click()
  await expect(auto).toBeChecked()
  await persisted(
    () =>
      window.__uiFixture.values.readFrogLiteConfig.pageTranslation.page.autoTranslatePatterns
        .length > 0,
  )
  await auto.click()
  await expect(auto).not.toBeChecked()
  await persisted(
    () =>
      window.__uiFixture.values.readFrogLiteConfig.pageTranslation.page.autoTranslatePatterns
        .length === 0,
  )
  passed.push("site auto-translation add/remove persists")
  await page.evaluate(async () => {
    const updatedConfig = structuredClone(window.__uiFixture.values.readFrogLiteConfig)
    updatedConfig.pageTranslation.page.autoTranslatePatterns = ["example.com"]
    await window.browser.storage.local.set({ readFrogLiteConfig: updatedConfig })
  })
  await expect(auto).toBeChecked()
  passed.push("external site configuration updates derived switch")
  const site = page.getByRole("switch", { name: "Disable extension on this site" })
  await site.click()
  await persisted(() =>
    window.__uiFixture.values.readFrogLiteConfig.siteControl.blacklistPatterns.some((p) =>
      p.includes("example.com"),
    ),
  )
  await expect(page.locator("[data-popup-translate]")).toBeDisabled()
  await site.click()
  await persisted(
    () => window.__uiFixture.values.readFrogLiteConfig.siteControl.blacklistPatterns.length === 0,
  )
  passed.push("site blacklist gates translation")
  const ai = page.getByRole("switch", { name: "AI Smart Context" })
  await expect(ai).not.toBeChecked()
  const writesBeforeDrag = await page.evaluate(
    () => window.__uiTrace.calls.filter((c) => c.name === "storage.set").length,
  )
  const box = await ai.boundingBox()
  await page.mouse.move(box.x + 4, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect(ai).toBeChecked()
  await persisted(
    () => window.__uiFixture.values.readFrogLiteConfig.pageTranslation.enableAIContentAware,
  )
  expect(
    (await page.evaluate(
      () => window.__uiTrace.calls.filter((c) => c.name === "storage.set").length,
    )) - writesBeforeDrag,
  ).toBe(2)
  passed.push("pointer drag toggles exactly once")
  expect(
    await ai
      .locator('[data-slot="switch-thumb"]')
      .evaluate((el) => getComputedStyle(el).transitionProperty),
  ).toBe("none")
  passed.push("reduced motion removes thumb transition")
  await page.evaluate(() => window.browser.storage.local.set({ theme: "light" }))
  await expect(page.locator("html")).toHaveClass(/light/)
  passed.push("theme storage synchronization")
  expect(
    await page.evaluate(() => window.__uiTrace.calls.filter((c) => c.name === "tabs.query").length),
  ).toBe(1)
  passed.push("all actions keep the captured tab; no repeated tabs query")
  for (const role of ["button", "switch", "combobox"])
    for (const element of await page.getByRole(role).all())
      await expect(element).toHaveAccessibleName(/\S/)
  passed.push("all visible primary controls have accessible names")
  await page.screenshot({ path: `${output}/after-interactions.png`, fullPage: true })
  expect(errors).toEqual([])
  await context.close()
} finally {
  await browser.close()
  server.close()
  await writeFile(`${output}/results.json`, JSON.stringify({ passed }, null, 2))
}
console.log(passed)

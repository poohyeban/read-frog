import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium, test, expect } from "@playwright/test"

for (const serviceWorkers of ["allow", "block"]) {
  test(`real YouTube with website service workers ${serviceWorkers}`, async () => {
    test.setTimeout(160000)
    const output = resolve(`.diagnostics/artifacts/sw-${serviceWorkers}`)
    await mkdir(output, { recursive: true })
    const extensionPath = resolve(".diagnostics/extension")
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      executablePath: resolve(".diagnostics/chrome/chrome-linux64/chrome"),
      headless: false,
      serviceWorkers,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    })
    context.setDefaultTimeout(10000)
    context.setDefaultNavigationTimeout(30000)
    const evidence = { serviceWorkers, browser: context.browser().version(), cases: [] }
    try {
      await context.tracing.start({ screenshots: true, snapshots: true })
      let worker =
        context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension:")) ??
        (await context.waitForEvent("serviceworker", {
          predicate: (w) => w.url().startsWith("chrome-extension:"),
        }))
      const extensionId = new URL(worker.url()).host
      await expect
        .poll(() =>
          worker.evaluate(async () =>
            Boolean((await chrome.storage.local.get("readFrogLiteConfig")).readFrogLiteConfig),
          ),
        )
        .toBe(true)
      await worker.evaluate(async () => {
        const { readFrogLiteConfig: config } = await chrome.storage.local.get("readFrogLiteConfig")
        config.videoSubtitles.enabled = true
        config.videoSubtitles.autoStart.youtube = false
        config.uiLanguage = "en"
        await chrome.storage.local.set({ readFrogLiteConfig: config })
      })
      const manager = await context.newPage()
      await manager.goto("chrome://extensions/")
      await manager.evaluate(
        () =>
          new Promise((done, reject) => {
            chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => {
              const error = chrome.runtime.lastError?.message
              if (error) reject(new Error(error))
              else done()
            })
          }),
      )
      const nextWorker = context.waitForEvent("serviceworker", {
        predicate: (w) => w !== worker && w.url().startsWith("chrome-extension:"),
      })
      await worker.evaluate(() => {
        setTimeout(() => chrome.runtime.reload(), 0)
      })
      worker = await nextWorker
      await expect.poll(() => worker.evaluate(() => chrome.runtime.id)).toBe(extensionId)
      async function readErrors() {
        return manager.evaluate(
          (id) =>
            new Promise((done, reject) => {
              chrome.developerPrivate.getExtensionInfo(id, (info) => {
                const error = chrome.runtime.lastError?.message
                if (error) reject(new Error(error))
                else done(info.runtimeErrors)
              })
            }),
          extensionId,
        )
      }
      async function clearErrors() {
        await manager.evaluate(
          (id) =>
            new Promise((done, reject) => {
              chrome.developerPrivate.deleteExtensionErrors({ extensionId: id }, () => {
                const error = chrome.runtime.lastError?.message
                if (error) reject(new Error(error))
                else done()
              })
            }),
          extensionId,
        )
      }
      const page = await context.newPage()
      let pageErrors = [],
        consoleErrors = []
      page.on("pageerror", (e) => pageErrors.push({ message: e.message, stack: e.stack }))
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push({ text: m.text(), location: m.location() })
      })
      async function capture(label) {
        const entry = {
          label,
          url: page.url(),
          title: await page.title(),
          runtimeURL: await worker.evaluate(() => chrome.runtime.getURL("content-runtime.js")),
          hostCount: await page.locator("read-frog-lite").count(),
          subtitleHostCount: await page.locator("#read-frog-subtitles-ui-host").count(),
          controller: await page.evaluate(
            () => navigator.serviceWorker?.controller?.scriptURL ?? null,
          ),
          errors: await readErrors(),
          pageErrors,
          consoleErrors,
        }
        evidence.cases.push(entry)
        await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2))
        console.log("SW_CASE", JSON.stringify({ serviceWorkers, ...entry }))
      }
      for (let i = 0; i < 3; i++) {
        await clearErrors()
        pageErrors = []
        consoleErrors = []
        const response = await page.goto(
          `https://www.youtube.com/watch?v=7ARBJQn6QkM&diagnostic=${i}`,
          { waitUntil: "domcontentloaded" },
        )
        expect(response.status()).toBe(200)
        await page.waitForTimeout(4000)
        await capture(`live navigation ${i + 1}`)
      }
      await clearErrors()
      pageErrors = []
      consoleErrors = []
      await page.reload({ waitUntil: "domcontentloaded" })
      await page.waitForTimeout(4000)
      await capture("live reload")
      await page.screenshot({ path: `${output}/youtube.png` })
    } finally {
      await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2))
      await context.tracing.stop({ path: `${output}/trace.zip` })
      await context.close()
    }
  })
}

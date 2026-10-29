import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"
import process from "node:process"
import { chromium, expect, test } from "@playwright/test"

// A real website worker handles fetch events. Extension modules must not be
// fetched through it. RUN_LIVE_YOUTUBE additionally repeats this on YouTube.
test("injected runtime survives website workers and handles missing or expired contexts", async () => {
  test.setTimeout(150_000)
  const output = resolve("test-results/runtime-evidence")
  await mkdir(output, { recursive: true })
  const extension = resolve(process.env.RUNTIME_EXTENSION_PATH || ".output/chrome-mv3")
  const evidence = { errors: [], pageErrors: [], cases: [] }
  const server = createServer((request, response) => {
    if (request.url === "/sw.js") {
      response.setHeader("Content-Type", "text/javascript")
      response.end(
        `self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>e.respondWith(fetch(e.request)));`,
      )
    } else {
      response.setHeader("Content-Type", "text/html")
      response.end(
        '<!doctype html><html lang="en"><head><title>Runtime regression</title></head><body><p>This ordinary English article verifies extension loading on a page controlled by a website service worker.</p></body></html>',
      )
    }
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const articleURL = `http://127.0.0.1:${server.address().port}/article`
  let context
  try {
    context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: false,
      executablePath: process.env.RUNTIME_BROWSER_PATH,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    })
    context.setDefaultNavigationTimeout(30000)
    await context.tracing.start({ screenshots: true, snapshots: true })
    evidence.browser = context.browser().version()
    let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
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
    const reloadExtension = async () => {
      const next = context.waitForEvent("serviceworker", {
        predicate: (candidate) =>
          candidate !== worker && candidate.url().startsWith("chrome-extension:"),
        timeout: 15000,
      })
      await worker.evaluate(() => {
        setTimeout(() => chrome.runtime.reload(), 0)
      })
      worker = await next
      await expect.poll(() => worker.evaluate(() => chrome.runtime.id)).toBe(extensionId)
    }
    await reloadExtension()
    const errors = async () => {
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
    const clearErrors = async () => {
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
    page.on("pageerror", (error) =>
      evidence.pageErrors.push({ message: error.message, stack: error.stack }),
    )
    await page.goto(articleURL)
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js")
      await navigator.serviceWorker.ready
    })
    for (let i = 0; i < 3; i++) {
      await page.reload()
      await expect
        .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
        .toBe(true)
      await expect(page.locator("read-frog-lite")).toHaveCount(1)
      await manager.bringToFront()
      await page.bringToFront()
    }
    await page.waitForTimeout(350)
    evidence.cases.push({
      label: "website service worker and internal-tab activation",
      errors: await errors(),
    })
    expect(evidence.cases.at(-1).errors).toEqual([])
    expect(evidence.pageErrors).toEqual([])

    await page.close()
    await clearErrors()
    evidence.pageErrors = []

    // Pause the actual shipped entrypoint just before reading configuration,
    // then reload the extension. This is the startup race missed by 0.2.3.
    await context.route("https://www.youtube.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><head><title>Subtitle startup race</title></head><body><p>Startup race</p></body></html>",
      }),
    )
    const startup = await context.newPage()
    startup.on("pageerror", (error) =>
      evidence.pageErrors.push({ message: error.message, stack: error.stack }),
    )
    const cdp = await context.newCDPSession(startup)
    try {
      await cdp.send("Debugger.enable")
      const script = await readFile(`${extension}/content-scripts/subtitles.js`, "utf8")
      const entry = script.indexOf(".__READ_FROG_SUBTITLES_INJECTED__=!0")
      expect(entry).toBeGreaterThan(0)
      const index = script.indexOf("await", entry)
      const prefix = script.slice(0, index).split("\n")
      const bp = await cdp.send("Debugger.setBreakpointByUrl", {
        url: `chrome-extension://${extensionId}/content-scripts/subtitles.js`,
        lineNumber: prefix.length - 1,
        columnNumber: prefix.at(-1).length,
      })
      const paused = new Promise((done) => cdp.once("Debugger.paused", done))
      const navigation = startup
        .goto("https://www.youtube.com/watch?v=startuprace")
        .catch((error) => ({ error: error.message }))
      await Promise.race([
        paused,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Startup breakpoint not hit")), 10000),
        ),
      ])
      await cdp.send("Debugger.removeBreakpoint", { breakpointId: bp.breakpointId })
      await reloadExtension()
      await cdp.send("Debugger.resume")
      await navigation
      await startup.waitForTimeout(750)
      evidence.errors = await errors()
      expect(evidence.pageErrors).toEqual([])
      expect(evidence.errors).toEqual([])
    } finally {
      await cdp.send("Debugger.resume").catch(() => {})
      await cdp.detach()
    }
    if (process.env.RUN_LIVE_YOUTUBE === "true") {
      // Run live navigation last: its service worker must not intercept the
      // controlled startup fixture used above.
      await startup.close()
      await context.unroute("https://www.youtube.com/**")
      const livePage = await context.newPage()
      for (let i = 0; i < 3; i++) {
        await clearErrors()
        await livePage.goto(`https://www.youtube.com/watch?v=7ARBJQn6QkM&runtimeRegression=${i}`, {
          waitUntil: "domcontentloaded",
        })
        await livePage.waitForTimeout(4000)
        await expect(livePage.locator("read-frog-lite")).toHaveCount(1)
        const controller = await livePage.evaluate(
          () => navigator.serviceWorker.controller?.scriptURL,
        )
        if (i > 0) expect(controller).toBe("https://www.youtube.com/sw.js")
        const extensionErrors = await errors()
        evidence.cases.push({ label: `live YouTube ${i + 1}`, controller, errors: extensionErrors })
        expect(extensionErrors).toEqual([])
      }
      await livePage.screenshot({ path: `${output}/youtube.png` })
    }
  } finally {
    await writeFile(`${output}/runtime.json`, JSON.stringify(evidence, null, 2))
    await context?.tracing.stop({ path: `${output}/trace.zip` })
    await context?.close()
    await new Promise((done) => server.close(done))
  }
})

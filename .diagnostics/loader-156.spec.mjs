import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"
import { chromium, test, expect } from "@playwright/test"

const extensionPath = resolvePath(".diagnostics/extension")
const watchURL = "https://www.youtube.com/watch?v=diagnostic1"
const fixture = `<!doctype html><html lang="en"><head><title>Read Frog loader diagnostic</title></head><body><p>This page contains enough ordinary English text for the extension to detect its language without accessing any remote translation service.</p><div id="movie_player" class="html5-video-player paused-mode" style="position:relative;width:960px;height:540px"><video class="html5-main-video"></video><div class="ytp-caption-window-container">Native captions</div><div class="ytp-chrome-bottom"><div class="ytp-right-controls"><button class="ytp-subtitles-button" aria-pressed="true">CC</button></div></div></div><script>const p=document.getElementById('movie_player');p.getPlayerResponse=()=>({videoDetails:{videoId:'diagnostic1',isLiveContent:false},captions:{playerCaptionsTracklistRenderer:{captionTracks:[]}}});p.getVideoData=()=>({video_id:'diagnostic1'});p.getPlayerState=()=>2;p.getOption=()=>null;p.getAudioTrack=()=>null;</script></body></html>`
const executablePath =
  process.env.DIAG_BROWSER === "156.47"
    ? resolvePath(".diagnostics/chrome/chrome-linux64/chrome")
    : undefined

test("diagnose published 0.2.3 loader and subtitle startup without modifying the bundle", async () => {
  test.setTimeout(240_000)
  const output = resolvePath(`.diagnostics/artifacts/${process.env.DIAG_BROWSER}`)
  await mkdir(output, { recursive: true })
  const evidence = { browser: null, cases: [], pageErrors: [], nativeErrors: [], console: [] }
  let context
  try {
    context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      executablePath,
      headless: false,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    })
    evidence.browser = context.browser().version()
    await context.tracing.start({ screenshots: true, snapshots: true })
    await context.route("https://www.youtube.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: fixture }),
    )
    await context.route("https://example.org/**", (route) =>
      route.fulfill({ contentType: "text/html", body: fixture }),
    )
    let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
    const extensionId = new URL(worker.url()).host
    evidence.extensionId = extensionId
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
    async function reloadExtension() {
      const next = context.waitForEvent("serviceworker", {
        predicate: (candidate) => candidate !== worker,
        timeout: 15000,
      })
      await worker.evaluate(() => {
        setTimeout(() => chrome.runtime.reload(), 0)
      })
      worker = await next
      await expect.poll(() => worker.evaluate(() => chrome.runtime.id)).toBe(extensionId)
    }
    await reloadExtension()
    async function errors() {
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
          new Promise((done) =>
            chrome.developerPrivate.deleteExtensionErrors({ extensionId: id }, done),
          ),
        extensionId,
      )
      evidence.pageErrors = []
      evidence.console = []
    }
    function observe(page) {
      page.on("pageerror", (error) =>
        evidence.pageErrors.push({ message: error.message, stack: error.stack }),
      )
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type()))
          evidence.console.push({
            type: message.type(),
            text: message.text(),
            location: message.location(),
          })
      })
    }
    async function capture(label, page, extra = {}) {
      await page.waitForTimeout(350)
      const entry = {
        label,
        url: page.url(),
        runtimeURL: await worker.evaluate(() => chrome.runtime.getURL("content-runtime.js")),
        hostCount: await page.locator("read-frog-lite").count(),
        subtitleHostCount: await page.locator("#read-frog-subtitles-ui-host").count(),
        errors: await errors(),
        pageErrors: [...evidence.pageErrors],
        console: [...evidence.console],
        ...extra,
      }
      evidence.cases.push(entry)
      console.log("LOADER_CASE", JSON.stringify({ browser: evidence.browser, ...entry }))
    }
    let page = await context.newPage()
    observe(page)
    for (let i = 0; i < 6; i++) {
      await clearErrors()
      await page.goto(`${watchURL}&fresh=${i}`)
      await page.waitForTimeout(750)
      await capture(`fresh navigation ${i + 1}`, page)
    }
    for (let i = 0; i < 4; i++) {
      await clearErrors()
      await page.reload()
      await page.waitForTimeout(500)
      await manager.bringToFront()
      await page.waitForTimeout(100)
      await page.bringToFront()
      await capture(`refresh and tab switch ${i + 1}`, page)
    }
    await clearErrors()
    await page.goto("https://example.org/bfcache-fixture")
    await page.goBack()
    await page.waitForTimeout(600)
    await capture("back navigation", page)
    await clearErrors()
    await manager.bringToFront()
    const discardedURL = page.url()
    const discardResult = await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)
      try {
        const discarded = await chrome.tabs.discard(tab.id)
        return { id: tab.id, discarded: discarded?.discarded ?? false }
      } catch (error) {
        return { error: error.message }
      }
    }, discardedURL)
    if (discardResult.discarded) {
      await worker.evaluate(
        async (id) => chrome.tabs.update(id, { active: true }),
        discardResult.id,
      )
      await expect.poll(() => context.pages().some((p) => p.url() === discardedURL)).toBe(true)
      page = context.pages().find((p) => p.url() === discardedURL)
      observe(page)
    }
    await page.bringToFront()
    await page.waitForTimeout(800)
    await capture("discard and reactivate", page, { discardResult })

    // Deliberately invalidate the extension while paused immediately before a
    // startup API/import. Only debugger scheduling changes; ZIP bytes do not.
    for (const target of ["subtitles", "loader"]) {
      await clearErrors()
      const faultPage = await context.newPage()
      observe(faultPage)
      const cdp = await context.newCDPSession(faultPage)
      await cdp.send("Debugger.enable")
      await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 16 })
      const script = await readFile(`${extensionPath}/content-scripts/${target}.js`, "utf8")
      let index
      if (target === "subtitles") {
        const start = script.indexOf("async main(e){if(window.__READ_FROG_SUBTITLES_INJECTED__)")
        expect(start).toBeGreaterThan(0)
        index = script.indexOf("let t=await", start)
      } else {
        index = script.indexOf("import(e.runtime.getURL(o))")
      }
      expect(index).toBeGreaterThan(0)
      const prefix = script.slice(0, index).split("\n")
      const location = {
        url: `chrome-extension://${extensionId}/content-scripts/${target}.js`,
        lineNumber: prefix.length - 1,
        columnNumber: prefix.at(-1).length,
      }
      const bp = await cdp.send("Debugger.setBreakpointByUrl", location)
      const paused = new Promise((done) => cdp.once("Debugger.paused", done))
      const navigation = faultPage
        .goto(`${watchURL}&fault=${target}`)
        .catch((error) => ({ navigationError: error.message }))
      const frame = await Promise.race([
        paused,
        new Promise((done) => setTimeout(() => done(null), 10000)),
      ])
      if (!frame) {
        await capture(`startup reload ${target}: breakpoint not hit`, faultPage, { breakpoint: bp })
      } else {
        await cdp.send("Debugger.removeBreakpoint", { breakpointId: bp.breakpointId })
        await reloadExtension()
        await cdp.send("Debugger.resume").catch(() => {})
        await navigation
        await faultPage.waitForTimeout(1000)
        await capture(`startup reload ${target}`, faultPage, {
          pausedAt: frame.callFrames[0]?.location,
        })
      }
      await cdp.detach()
      await faultPage.close()
    }
    evidence.nativeErrors = await errors()
  } finally {
    await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2))
    console.log(
      "LOADER_DIAGNOSIS",
      JSON.stringify({ browser: evidence.browser, cases: evidence.cases.length }),
    )
    await context?.tracing.stop({ path: `${output}/trace.zip` })
    await context?.close()
  }
})

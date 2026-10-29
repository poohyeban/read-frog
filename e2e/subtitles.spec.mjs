import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"
import process from "node:process"
import { chromium, expect, test } from "@playwright/test"

const videoId = "fixture1234"
const watchURL = `https://www.youtube.com/watch?v=${videoId}`
const cueText = (index) =>
  `Fixture cue number ${index} contains a complete English sentence with enough context to keep it separate from adjacent subtitle sentences.`
const cues = [
  ...Array.from({ length: 26 }, (_, index) => ({ index, start: index * 6, duration: 5 })),
  { index: 99, start: 180, duration: 40 },
  { index: 100, start: 300, duration: 5 },
]

// Only YouTube's page/player and the paid API are controlled fixtures. The
// shipped interceptor, subtitle fetcher, scheduler, queues and SDK run unchanged.
test("subtitles retain timing across batches, AI recuts and extension reloads", async () => {
  test.setTimeout(150_000)
  const artifactDir = resolve(process.env.SUBTITLE_ARTIFACT_DIR || "test-results/subtitle-evidence")
  await mkdir(artifactDir, { recursive: true })
  let segmentationMode = "aligned"
  const requests = []
  const evidence = { requests, pageErrors: [], console: [] }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "*")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end()
      return
    }
    let body = ""
    for await (const chunk of request) body += chunk.toString()
    const payload = JSON.parse(body)
    const input = payload.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n")
    const indices = [...input.matchAll(/Fixture cue number (\d+)/g)].map((match) =>
      Number(match[1]),
    )
    const isSegmentation = payload.messages.some(
      (message) =>
        message.role === "system" && message.content.includes("subtitle segmentation expert"),
    )
    requests.push({ indices, model: payload.model, segmentation: isSegmentation })
    let content
    if (isSegmentation) {
      const fragments = JSON.parse(input.slice(input.indexOf("["), input.lastIndexOf("]") + 1))
      const shift = segmentationMode === "shifted" ? 10_000 : 0
      content = `WEBVTT\n\n${fragments.map((cue) => `${cue.s + shift} --> ${cue.e + shift}\n${cue.t}`).join("\n\n")}`
    } else {
      // A slow but healthy first response must still resolve normally.
      if (indices.includes(0)) await new Promise((done) => setTimeout(done, 1200))
      content = indices.map((index) => `已翻译字幕 ${index}。`).join("\n\n%%\n\n")
    }
    response.setHeader("Content-Type", "application/json")
    response.end(
      JSON.stringify({
        id: "subtitle-fixture",
        object: "chat.completion",
        created: 1,
        model: payload.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    )
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`
  let context
  try {
    const extension = resolve(process.env.SUBTITLE_EXTENSION_PATH || ".output/chrome-mv3")
    context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: !process.env.CI,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    })
    await context.tracing.start({ screenshots: true, snapshots: true })
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
    await expect
      .poll(() =>
        worker.evaluate(async () =>
          Boolean((await chrome.storage.local.get("readFrogLiteConfig")).readFrogLiteConfig),
        ),
      )
      .toBe(true)
    await worker.evaluate(async (baseURL) => {
      const { readFrogLiteConfig: config } = await chrome.storage.local.get("readFrogLiteConfig")
      const providerId = config.videoSubtitles.providerId || "deepseek-default"
      const provider = {
        id: providerId,
        provider: "deepseek",
        name: "Local subtitle fixture",
        enabled: true,
        apiKey: "subtitle-fixture-key",
        baseURL,
        model: { model: "deepseek-flash", isCustomModel: true, customModel: "deepseek-flash" },
      }
      config.providersConfig = [
        ...config.providersConfig.filter((item) => item.id !== providerId),
        provider,
      ]
      config.videoSubtitles.providerId = providerId
      config.videoSubtitles.enabled = true
      config.videoSubtitles.autoStart.youtube = true
      config.videoSubtitles.aiSegmentation = false
      config.videoSubtitles.requestQueueConfig = { rate: 20, capacity: 20 }
      config.videoSubtitles.batchQueueConfig.maxItemsPerBatch = 1
      config.videoSubtitles.style.displayMode = "bilingual"
      config.pageTranslation.enableAIContentAware = false
      config.language.sourceCode = "eng"
      config.language.targetCode = "cmn"
      config.glossary.enabled = false
      config.uiLanguage = "en"
      await chrome.storage.local.set({ readFrogLiteConfig: config })
    }, endpoint)
    const page = await context.newPage()
    page.on("pageerror", (error) => evidence.pageErrors.push(error.message))
    page.on("console", (message) =>
      evidence.console.push({ type: message.type(), text: message.text() }),
    )
    await page.route("https://www.youtube.com/**", async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === "/api/timedtext") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: cues.map((cue) => ({
              tStartMs: cue.start * 1000,
              dDurationMs: cue.duration * 1000,
              segs: [{ utf8: cueText(cue.index) }],
            })),
          }),
        })
        return
      }
      if (url.pathname !== "/watch") {
        await route.fulfill({ status: 404, body: "" })
        return
      }
      const track = {
        baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`,
        languageCode: "en",
        vssId: ".en",
        name: { simpleText: "English" },
      }
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><title>Subtitle diagnostic fixture</title><style>body{margin:0;background:#333;color:white}#movie_player{position:relative;width:960px;height:540px;background:#111}video{width:100%;height:100%}.ytp-chrome-bottom{position:absolute;bottom:0;width:100%;height:50px}.ytp-right-controls{float:right}.ytp-caption-window-container{position:absolute;bottom:80px;left:30px}</style></head><body><div id="movie_player" class="html5-video-player paused-mode"><video class="html5-main-video"></video><div class="ytp-caption-window-container">Native captions available</div><div class="ytp-chrome-bottom"><div class="ytp-right-controls"><button class="ytp-subtitles-button" aria-pressed="true">CC</button></div></div></div><script>const p=document.getElementById('movie_player');const track=${JSON.stringify(track)};p.getPlayerResponse=()=>({videoDetails:{videoId:'${videoId}',isLiveContent:false},captions:{playerCaptionsTracklistRenderer:{captionTracks:[track],audioTracks:[{captionTrackIndices:[0],defaultCaptionTrackIndex:0}],defaultAudioTrackIndex:0}}});p.getVideoData=()=>({video_id:'${videoId}'});p.getPlayerState=()=>2;p.getOption=()=>track;p.getAudioTrack=()=>({captionTracks:[{...track,url:track.baseUrl}]});</script></body></html>`,
      })
    })
    await page.goto(watchURL)
    const translation = page.locator("#read-frog-subtitles-ui-host .subtitles-translation")
    const moveTo = async (seconds) => {
      await page.locator("video").evaluate((video, time) => {
        video.currentTime = time
        video.dispatchEvent(new Event("timeupdate"))
        video.dispatchEvent(new Event("seeked"))
      }, seconds)
    }
    await expect(page.locator("#read-frog-subtitles-ui-host")).toBeAttached()
    await moveTo(1)
    await expect(translation).toContainText("已翻译字幕 0。")
    for (let index = 1; index <= 20; index++) {
      await moveTo(index * 6 + 1)
      await expect(translation).toContainText(`已翻译字幕 ${index}。`)
    }
    evidence.continuousCuesTranslated = 21
    await page.screenshot({ path: `${artifactDir}/continuous-translation.png` })
    // The next cue was never in the prefetch window. Its start is twenty seconds
    // behind the seek destination, but it is still the visible cue.
    await moveTo(200)
    await expect(translation).toContainText("已翻译字幕 99。")
    await expect(translation).not.toHaveAttribute("data-pending", "true")
    evidence.longCue = {
      pending: await translation.getAttribute("data-pending"),
      text: await translation.textContent(),
      requested: requests.some((request) => request.indices.includes(99)),
    }
    await page.screenshot({ path: `${artifactDir}/long-active-cue.png` })
    const otherTab = await context.newPage()
    await otherTab.goto("chrome://extensions/")
    // This fresh automation profile must enable developer mode for unpacked
    // extension reloads, just like a user's chrome://extensions installation.
    await otherTab.evaluate(
      () =>
        new Promise((done, reject) => {
          chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => {
            const error = chrome.runtime.lastError?.message
            if (error) reject(new Error(error))
            else done()
          })
        }),
    )
    await otherTab.bringToFront()
    await worker.evaluate(() => {
      setTimeout(() => chrome.runtime.reload(), 0)
    })
    await expect.poll(() => worker.evaluate(() => chrome.runtime.id).catch(() => null)).toBeNull()
    const errorsBefore = evidence.pageErrors.length
    await page.bringToFront()
    await page.waitForTimeout(300)
    await moveTo(301)
    await expect(page.locator("#read-frog-subtitles-ui-host")).toHaveCount(0)
    await expect(page.locator("#read-frog-hide-native-captions")).toHaveCount(0)
    await expect(page.locator(".ytp-caption-window-container")).toBeVisible()
    expect(evidence.pageErrors.slice(errorsBefore)).not.toContain("Extension context invalidated.")
    evidence.afterReload = {
      overlayCount: await page.locator("#read-frog-subtitles-ui-host").count(),
      hidesNativeCaptions: await page.locator("#read-frog-hide-native-captions").count(),
      pageErrors: evidence.pageErrors.slice(errorsBefore),
    }
    await page.screenshot({ path: `${artifactDir}/after-extension-reload.png` })
    // Wake the replacement worker and wait until the reloaded extension is ready
    // before refreshing the tab; its old worker disappearing is only the start.
    const options = await context.newPage()
    await options.goto(`chrome-extension://${worker.url().split("/")[2]}/options.html`)
    await options.waitForFunction(() => typeof chrome.runtime?.id === "string")
    await page.bringToFront()
    await page.reload()
    await expect(page.locator("#read-frog-subtitles-ui-host")).toBeAttached()
    await moveTo(1)
    await expect(translation).toContainText("已翻译字幕 0。")
    evidence.recoveredAfterPageRefresh = true
    evidence.segmentation = []
    for (const mode of ["aligned", "shifted"]) {
      segmentationMode = mode
      await options.evaluate(async (model) => {
        const { readFrogLiteConfig: config } = await chrome.storage.local.get("readFrogLiteConfig")
        config.videoSubtitles.aiSegmentation = true
        const provider = config.providersConfig.find(
          (item) => item.id === config.videoSubtitles.providerId,
        )
        provider.model = { model, customModel: model, isCustomModel: true }
        await chrome.storage.local.set({ readFrogLiteConfig: config })
      }, `deepseek-fixture-${mode}`)
      const requestCount = requests.filter((request) => request.segmentation).length
      await page.reload()
      await expect(page.locator("#read-frog-subtitles-ui-host")).toBeAttached()
      await expect
        .poll(() => requests.filter((request) => request.segmentation).length)
        .toBeGreaterThan(requestCount)
      for (let index = 0; index < 6; index++) {
        await moveTo(index * 6 + 1)
        await expect(translation).toContainText(`已翻译字幕 ${index}。`)
      }
      evidence.segmentation.push({ mode, synchronizedCues: 6 })
    }
    expect(evidence.pageErrors).toEqual([])
    console.log("SUBTITLE_EVIDENCE", JSON.stringify(evidence))
  } finally {
    await writeFile(`${artifactDir}/subtitles.json`, JSON.stringify(evidence, null, 2))
    await context?.tracing.stop({ path: `${artifactDir}/trace.zip` })
    await context?.close()
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
})

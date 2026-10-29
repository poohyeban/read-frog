import type { BrowserContext } from "@playwright/test"
import type { Config } from "../src/types/config/config"
import { createServer } from "node:http"
import { resolve } from "node:path"
import process from "node:process"
import { chromium, expect, test } from "@playwright/test"

type ExtensionAPI = {
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, Config>>
      set: (value: Record<string, Config>) => Promise<void>
    }
  }
}
const original =
  "This paragraph provides enough English words for a realistic page translation check."
const translated = "这是本地测试服务返回的译文。"
const credential = "e2e-local-test-key"

test("unpacked MV3: local API, bilingual/only/restore, selection, input and persistence", async () => {
  const apiRequests: { authorization: string | undefined; body: string }[] = []
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "*")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    if (request.url === "/article") {
      response.setHeader("Content-Type", "text/html")
      response.end(
        `<!doctype html><html lang="en"><head><title>Local regression fixture</title></head><body><main><p id="article">${original}</p><textarea aria-label="Editor"></textarea></main></body></html>`,
      )
      return
    }
    if (request.url === "/v1/chat/completions") {
      let body = ""
      for await (const chunk of request) body += chunk.toString()
      apiRequests.push({ authorization: request.headers.authorization, body })
      const payload: { stream?: boolean } = JSON.parse(body)
      if (payload.stream) {
        response.setHeader("Content-Type", "text/event-stream")
        for (const choices of [
          [{ index: 0, delta: { role: "assistant", content: translated }, finish_reason: null }],
          [{ index: 0, delta: {}, finish_reason: "stop" }],
        ])
          response.write(
            `data: ${JSON.stringify({ id: "local-test", object: "chat.completion.chunk", created: 1, model: "local-test", choices })}\n\n`,
          )
        response.end("data: [DONE]\n\n")
      } else {
        response.setHeader("Content-Type", "application/json")
        response.end(
          JSON.stringify({
            id: "local-test",
            object: "chat.completion",
            created: 1,
            model: "local-test",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: translated },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        )
      }
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Local fixture did not start")
  const origin = `http://127.0.0.1:${address.port}`
  const extensionPath = resolve(".output/chrome-mv3")
  let context: BrowserContext | undefined
  const externalRequests: string[] = []
  const errors: string[] = []
  try {
    context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      headless: !process.env.CI,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    })
    context.on("request", (request) => {
      const url = new URL(request.url())
      if (["http:", "https:"].includes(url.protocol) && url.hostname !== "127.0.0.1")
        externalRequests.push(`${url.origin}${url.pathname}`)
    })
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)))
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 15_000 }))
    const extensionId = new URL(worker.url()).host
    await expect
      .poll(() =>
        worker.evaluate(async () => {
          const api = (globalThis as unknown as { chrome: ExtensionAPI }).chrome
          return Boolean((await api.storage.local.get("readFrogLiteConfig")).readFrogLiteConfig)
        }),
      )
      .toBe(true)
    expect(apiRequests).toHaveLength(0)
    await worker.evaluate(
      async ({ endpoint, key }) => {
        const api = (globalThis as unknown as { chrome: ExtensionAPI }).chrome
        const config = (await api.storage.local.get("readFrogLiteConfig")).readFrogLiteConfig!
        const id = config.pageTranslation.providerId
        config.providersConfig = config.providersConfig.map((provider) =>
          provider.id === id
            ? {
                ...provider,
                provider: "openai-compatible",
                name: "Local regression API",
                enabled: true,
                apiKey: key,
                baseURL: `${endpoint}/v1`,
                model: {
                  model: "use-custom-model",
                  isCustomModel: true,
                  customModel: "local-test",
                },
              }
            : provider,
        )
        config.uiLanguage = "en"
        config.language.sourceCode = "eng"
        config.language.targetCode = "cmn"
        config.pageTranslation.page.translateTitle = false
        config.pageTranslation.batchQueueConfig.maxItemsPerBatch = 1
        config.inputTranslation.fromLang = "eng"
        config.inputTranslation.toLang = "cmn"
        await api.storage.local.set({ readFrogLiteConfig: config })
      },
      { endpoint: origin, key: credential },
    )
    const page = await context.newPage()
    await page.goto(`${origin}/article`)
    await expect(page.locator(".read-frog-react-shadow-host").first()).toBeAttached()
    await page.keyboard.press("Alt+e")
    await expect(page.locator("#article .read-frog-translated-content-wrapper")).toContainText(
      translated,
    )
    await expect(page.locator("#article")).toContainText(original)
    await page.keyboard.press("Alt+Shift+m")
    await expect(page.locator("#article")).toContainText(translated)
    await expect(page.locator("#article")).not.toContainText(original)
    await page.keyboard.press("Alt+e")
    await expect(page.locator("#article")).toHaveText(original)
    await expect(page.locator(".read-frog-translated-content-wrapper")).toHaveCount(0)
    await page.locator("#article").evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    await page.keyboard.press("Alt+t")
    await expect(page.getByText(translated, { exact: true }).first()).toBeVisible()
    await page.keyboard.press("Escape")
    await page
      .getByRole("textbox", { name: "Editor" })
      .fill("Please translate this sentence into Chinese.")
    await page.keyboard.press("Space")
    await page.keyboard.press("Space")
    await page.keyboard.press("Space")
    await expect(page.getByRole("textbox", { name: "Editor" })).toHaveValue(translated)
    expect(await page.content()).not.toContain(credential)
    await page.reload()
    await expect(page.locator("#article")).toHaveText(original)
    const options = await context.newPage()
    await options.goto(`chrome-extension://${extensionId}/options.html#/api-providers`)
    await expect(options.getByText("Local regression API").first()).toBeVisible()
    await options.reload()
    await expect(options.getByText("Local regression API").first()).toBeVisible()
    expect(apiRequests.length).toBeGreaterThanOrEqual(3)
    expect(apiRequests.every((request) => request.authorization === `Bearer ${credential}`)).toBe(
      true,
    )
    expect(apiRequests.every((request) => !request.body.includes(credential))).toBe(true)
    expect(externalRequests).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await context?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})

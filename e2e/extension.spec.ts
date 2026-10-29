import type { BrowserContext } from "@playwright/test"
import type { Config } from "../src/types/config/config"
import { readFile } from "node:fs/promises"
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
const structuredResult = "DeepSeek local structured result"

test("unpacked MV3: translation, DeepSeek actions, diagnostics, images and credential isolation", async () => {
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
      const payload: {
        stream?: boolean
        response_format?: { type: string }
        messages: { role: string; content: string }[]
      } = JSON.parse(body)
      if (payload.response_format?.type === "json_schema") {
        response.writeHead(400, { "Content-Type": "application/json" })
        response.end(
          JSON.stringify({
            error: {
              message: `Unsupported response_format json_schema. Reflected credential: ${credential}`,
              type: "invalid_request_error",
              param: "response_format",
            },
          }),
        )
        return
      }
      if (payload.stream) {
        let content = translated
        if (payload.response_format?.type === "json_object") {
          const schemaMessage = payload.messages.find(
            (message) =>
              message.role === "system" &&
              message.content.startsWith("Return JSON that conforms to the following schema: "),
          )
          if (!schemaMessage) {
            response
              .writeHead(400, { "Content-Type": "application/json" })
              .end(JSON.stringify({ error: { message: "JSON schema prompt is missing" } }))
            return
          }
          const schema: { properties: Record<string, { type: string }> } = JSON.parse(
            schemaMessage.content.slice(schemaMessage.content.indexOf("{")),
          )
          content = JSON.stringify(
            Object.fromEntries(
              Object.entries(schema.properties).map(([key, field]) => [
                key,
                field.type === "number" ? 2 : structuredResult,
              ]),
            ),
          )
        }
        response.setHeader("Content-Type", "text/event-stream")
        for (const choices of [
          [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
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
    await context.tracing.start({ screenshots: true, snapshots: true })
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
                id: provider.id,
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
        config.pageTranslation.node.enabled = true
        config.pageTranslation.node.hotkey = "backtick"
        config.pageTranslation.batchQueueConfig.maxItemsPerBatch = 1
        config.inputTranslation.fromLang = "eng"
        config.inputTranslation.toLang = "cmn"
        config.selectionToolbar.builtInActions.dictionary.providerId = id
        config.selectionToolbar.builtInActions.sentenceAnalysis.providerId = id
        await api.storage.local.set({ readFrogLiteConfig: config })
      },
      { endpoint: origin, key: credential },
    )
    const page = await context.newPage()
    const consoleMessages: string[] = []
    page.on("console", (message) => consoleMessages.push(message.text()))
    await page.goto(`${origin}/article`)
    await expect(page.locator("read-frog-lite button").first()).toBeVisible()
    const logoDataURL = `data:image/png;base64,${(await readFile("src/assets/icons/read-frog.png")).toString("base64")}`
    const floatingLogo = page.locator("read-frog-lite img").filter({ visible: true }).first()
    await expect(floatingLogo).toHaveAttribute("src", logoDataURL)
    await expect
      .poll(() =>
        floatingLogo.evaluate(
          (element: HTMLImageElement) => element.complete && element.naturalWidth > 0,
        ),
      )
      .toBe(true)
    // The subtitle UI uses the same built-in image. Verify the shipped script
    // embeds its bytes instead of issuing another chrome-extension URL request.
    expect(await readFile(".output/chrome-mv3/content-scripts/subtitles.js", "utf8")).toContain(
      logoDataURL,
    )
    // A generic SPA retains our wrapper while replacing its own text node.
    // No YouTube URL/selector is involved; page translation is still OFF.
    const article = page.locator("#article")
    await article.hover()
    await page.keyboard.press("`")
    await expect(article.locator(".read-frog-translated-content-wrapper")).toContainText(translated)
    const nextTitle = "This is the new article heading after client-side navigation."
    await article.evaluate((element, text) => {
      history.pushState({}, "", "?article=second")
      element.firstChild!.remove()
      element.append(text)
    }, nextTitle)
    await expect(article).toHaveText(nextTitle)
    await expect(article.locator(".read-frog-translated-content-wrapper")).toHaveCount(0)
    await article.hover()
    await page.keyboard.press("`")
    await expect(article.locator(".read-frog-translated-content-wrapper")).toContainText(translated)
    expect(apiRequests.some((request) => request.body.includes(nextTitle))).toBe(true)
    await article.evaluate((element, text) => {
      element.textContent = text
    }, original)
    await expect(article.locator(".read-frog-translated-content-wrapper")).toHaveCount(0)
    await page.keyboard.press("Alt+e")
    await expect(page.locator("#article .read-frog-translated-content-wrapper")).toContainText(
      translated,
    )
    await expect(page.locator("#article")).toContainText(original)
    await page.keyboard.press("Alt+Shift+m")
    await expect
      .poll(() =>
        worker.evaluate(async () => {
          const api = (globalThis as unknown as { chrome: ExtensionAPI }).chrome
          return (await api.storage.local.get("readFrogLiteConfig")).readFrogLiteConfig
            ?.pageTranslation.mode
        }),
      )
      .toBe("translationOnly")
    // Upstream applies a changed mode to the next translation session.
    await page.keyboard.press("Alt+e")
    await expect(page.locator("#article")).toHaveText(original)
    await page.keyboard.press("Alt+e")
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
    const providerIcon = page
      .getByRole("img", { name: "Local regression API", exact: true })
      .first()
    await expect(providerIcon).toHaveAttribute("src", /^data:image\/svg\+xml/)
    await expect
      .poll(() =>
        providerIcon.evaluate(
          (element: HTMLImageElement) => element.complete && element.naturalWidth > 0,
        ),
      )
      .toBe(true)
    await page.keyboard.press("Escape")
    await page
      .getByRole("textbox", { name: "Editor" })
      .fill("Please translate this sentence into Chinese.")
    await page.keyboard.press("Space")
    await page.keyboard.press("Space")
    await page.keyboard.press("Space")
    await expect(page.getByRole("textbox", { name: "Editor" })).toHaveValue(translated)
    for (const [index, shortcut] of ["Alt+Shift+d", "Alt+Shift+g"].entries()) {
      await page.locator("#article").evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      })
      await page.keyboard.press(shortcut)
      await expect
        .poll(
          () =>
            consoleMessages.filter((message) => message.startsWith("[Read Frog Lite][stream]"))
              .length,
        )
        .toBe(index + 1)
      const message = consoleMessages.filter((entry) =>
        entry.startsWith("[Read Frog Lite][stream]"),
      )[index]!
      const diagnostic = JSON.parse(message.slice("[Read Frog Lite][stream] ".length))
      expect(diagnostic).toMatchObject({
        scope: "content",
        phase: "request",
        port: "stream-structured-object",
        httpStatus: 400,
        responseFormat: "json_schema",
        reason: "response_format_rejected",
      })
      await expect(page.getByRole("alert")).toHaveCount(0)
      await expect(page.getByText("Unsupported response_format", { exact: false })).toHaveCount(0)
      await page.keyboard.press("Escape")
    }
    // Use the real dedicated SDK through the same background/selection flow.
    await worker.evaluate(async () => {
      const api = (globalThis as unknown as { chrome: ExtensionAPI }).chrome
      const config = (await api.storage.local.get("readFrogLiteConfig")).readFrogLiteConfig!
      config.providersConfig = config.providersConfig.map((provider) =>
        provider.id === config.pageTranslation.providerId
          ? {
              ...provider,
              provider: "deepseek",
              model: {
                model: "deepseek-flash",
                isCustomModel: true,
                customModel: "deepseek-flash",
              },
            }
          : provider,
      )
      config.pageTranslation.mode = "bilingual"
      await api.storage.local.set({ readFrogLiteConfig: config })
    })
    await page.reload()
    await expect(page.locator("read-frog-lite button").first()).toBeVisible()
    await page.keyboard.press("Alt+e")
    await expect(page.locator("#article")).toContainText(translated)
    await expect(page.locator("#article")).toContainText(original)
    await page.keyboard.press("Alt+e")
    await expect(page.locator("#article")).toHaveText(original)
    for (const shortcut of ["Alt+Shift+d", "Alt+Shift+g"]) {
      await page.locator("#article").evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      })
      await page.keyboard.press(shortcut)
      await expect(page.getByText(structuredResult, { exact: true }).first()).toBeVisible()
      await expect(page.getByRole("alert")).toHaveCount(0)
      await page.keyboard.press("Escape")
    }
    expect(
      apiRequests.filter(
        (request) => JSON.parse(request.body).response_format?.type === "json_object",
      ).length,
    ).toBeGreaterThanOrEqual(2)
    expect(
      consoleMessages.filter((message) => message.startsWith("[Read Frog Lite][stream]")),
    ).toHaveLength(2)
    expect(consoleMessages.join("\n")).not.toContain(credential)
    const renderedMarkup = await page.evaluate(() => {
      function markup(root: Document | ShadowRoot): string {
        return [...root.querySelectorAll("*")]
          .map(
            (element) => element.outerHTML + (element.shadowRoot ? markup(element.shadowRoot) : ""),
          )
          .join("\n")
      }
      return markup(document)
    })
    expect(renderedMarkup).not.toContain(credential)
    await page.reload()
    await expect(page.locator("#article")).toHaveText(original)
    const options = await context.newPage()
    await options.goto(`chrome-extension://${extensionId}/options.html#/api-providers`)
    await expect(options.getByText("Local regression API").first()).toBeVisible()
    await options.reload()
    await expect(options.getByText("Local regression API").first()).toBeVisible()
    await options.getByRole("button", { name: "Add provider", exact: true }).click()
    const dialog = options.getByRole("dialog", { name: "Add new provider" })
    await expect(
      dialog
        .getByRole("heading", { name: "Built-in LLM providers", exact: true })
        .locator("..")
        .getByRole("button", { name: "DeepSeek", exact: true }),
    ).toBeVisible()
    const lightLogos = new Map<string, string>()
    for (const colorScheme of ["light", "dark"] as const) {
      await options.emulateMedia({ colorScheme })
      await expect(options.locator("html")).toHaveClass(new RegExp(`\\b${colorScheme}\\b`))
      const logos: string[] = []
      for (const name of ["OpenAI", "DeepSeek", "Gemini", "Ollama", "Custom Chat Complete"]) {
        const icon = dialog.getByRole("button", { name, exact: true }).locator("img")
        await expect(icon).toHaveAttribute("src", /^data:image\/svg\+xml/)
        await expect
          .poll(() =>
            icon.evaluate(
              (element: HTMLImageElement) => element.complete && element.naturalWidth > 0,
            ),
          )
          .toBe(true)
        const src = (await icon.getAttribute("src"))!
        logos.push(src)
        if (colorScheme === "light") lightLogos.set(name, src)
        else if (name === "OpenAI" || name === "Ollama") expect(src).not.toBe(lightLogos.get(name))
      }
      expect(new Set(logos).size).toBe(5)
    }
    await options.keyboard.press("Escape")
    expect(apiRequests.length).toBeGreaterThanOrEqual(3)
    expect(apiRequests.every((request) => request.authorization === `Bearer ${credential}`)).toBe(
      true,
    )
    expect(apiRequests.every((request) => !request.body.includes(credential))).toBe(true)
    expect(externalRequests).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await context?.tracing.stop({ path: test.info().outputPath("trace.zip") })
    await context?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})

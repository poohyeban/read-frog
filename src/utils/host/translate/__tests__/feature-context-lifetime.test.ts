// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { sendMessage } from "@/utils/message"
import {
  translateTextForInput,
  translateTextForPage,
  translateTextForPageTitle,
} from "../translate-variants"
import {
  beginPageTranslationSession,
  endPageTranslationSession,
  getPageTranslationSession,
} from "../translation-session"
import { releaseWebPageContext } from "../webpage-context"
import { getOrGenerateWebPageSummary, releaseWebPageSummaries } from "../webpage-summary"

const { config, message } = vi.hoisted(() => ({
  config: vi.fn<(...args: any[]) => any>(),
  message: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("@/utils/config/storage", () => ({ getLocalConfig: config }))
vi.mock("@/utils/message", () => ({ sendMessage: message }))
vi.mock("defuddle/full", () => ({
  default: class {
    parse() {
      return { content: "<p>Original article about frogs.</p>" }
    }
  },
  createMarkdownContent: () => "Original article about frogs.",
}))

beforeEach(() => {
  vi.clearAllMocks()
  document.title = "Frog research"
  document.body.innerHTML = "<main><p>Original article about frogs.</p></main>"
  const settings = structuredClone(DEFAULT_CONFIG)
  settings.pageTranslation.enableAIContentAware = true
  settings.language.sourceCode = "eng"
  settings.language.targetCode = "cmn"
  config.mockResolvedValue(settings)
})
afterEach(() => {
  endPageTranslationSession()
  releaseWebPageContext()
  releaseWebPageSummaries()
})

describe("cross-feature context ownership", () => {
  it("keeps independent input running while page-only summary preparation is cancelled", async () => {
    let finish!: (value: string) => void
    message.mockImplementation((name) =>
      name === "getOrGenerateWebPageSummary"
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve("Translated input"),
    )
    beginPageTranslationSession()
    const page = translateTextForPage("This English paragraph needs accurate translation.").catch(
      (error) => error,
    )
    const input = translateTextForInput(
      "This independent input also needs translation.",
      "sourceCode",
      "targetCode",
    )
    await vi.waitFor(() =>
      expect(
        message.mock.calls.filter(([name]) => name === "getOrGenerateWebPageSummary"),
      ).toHaveLength(1),
    )
    endPageTranslationSession()
    finish("Shared article summary")
    expect(await page).toMatchObject({ name: "TranslationCancelledError" })
    await expect(input).resolves.toBe("Translated input")
    expect(
      message.mock.calls.filter(([name]) => name === "cancelPageTranslationRequests"),
    ).toHaveLength(1)
    const execution = message.mock.calls.find(([name]) => name === "enqueueTranslateRequest")!
    expect(execution[1].sessionId).toMatch(/^request-/)
  })
  it("cancels the underlying scoped message only after the last subscriber exits", async () => {
    message.mockImplementation((name) =>
      name === "getOrGenerateWebPageSummary" ? new Promise(() => {}) : Promise.resolve(),
    )
    const settings = await config()
    const providerRef = { kind: "local" as const, config: settings.providersConfig[0] }
    const context = { url: location.href, webTitle: "Title", webContent: "Original source" }
    beginPageTranslationSession()
    const other = new AbortController()
    const page = getOrGenerateWebPageSummary(
      context,
      providerRef,
      true,
      getPageTranslationSession(),
    ).catch((error) => error)
    const input = getOrGenerateWebPageSummary(context, providerRef, true, {
      id: "input",
      signal: other.signal,
    }).catch((error) => error)
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    const scopeId = message.mock.calls[0]![1].sessionId
    expect(scopeId).toMatch(/^context-/)
    endPageTranslationSession()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    other.abort()
    expect(message).toHaveBeenLastCalledWith("cancelPageTranslationRequests", {
      sessionId: scopeId,
    })
    expect(await page).toMatchObject({ name: "TranslationCancelledError" })
    expect(await input).toMatchObject({ name: "TranslationCancelledError" })
  })
})

it("cancels a title request without draining the page's body scope", async () => {
  const requests = new Map<string, (value: string) => void>()
  message.mockImplementation((name, data) => {
    if (name === "getOrGenerateWebPageSummary") return Promise.resolve("Shared summary")
    if (name === "enqueueTranslateRequest")
      return new Promise<string>((resolve) => requests.set(data.sessionId, resolve))
    return Promise.resolve()
  })
  const pageId = beginPageTranslationSession()
  const titleOwner = new AbortController()
  const title = translateTextForPageTitle("An article title", titleOwner.signal).catch(
    (error) => error,
  )
  const body = translateTextForPage(
    "This English paragraph continues after title translation is disabled.",
  )
  await vi.waitFor(() => expect(requests.size).toBe(2))
  titleOwner.abort()
  expect(await title).toMatchObject({ name: "TranslationCancelledError" })
  const cancellations = message.mock.calls.filter(
    ([name]) => name === "cancelPageTranslationRequests",
  )
  expect(cancellations).toHaveLength(1)
  expect(cancellations[0]![1].sessionId).toMatch(/^title-/)
  requests.get(pageId)!("Body translation")
  expect(await body).toBe("Body translation")
})

it("does not start translation after its source changes while the one summary request is pending", async () => {
  const settings = await config()
  document.body.innerHTML = `<article><h1>Original title</h1><p>${"Original English source. ".repeat(200)}</p></article>`
  const source = document.querySelector("p")!
  const original = source.textContent
  let finish!: (text: string) => void
  message.mockImplementation((name) =>
    name === "getOrGenerateWebPageSummary"
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve("Old translation"),
  )
  // Explicit custom summary keeps this reproduction independent of projection length.
  settings.pageTranslation.customPromptsConfig = {
    promptId: "model-summary",
    patterns: [
      {
        id: "model-summary",
        name: "Model summary",
        systemPrompt: "Translate with {{webSummary}}",
        prompt: "{{input}}",
      },
    ],
  }
  const pending = translateTextForPage(original, "plain", {
    source,
    config: settings,
    isSourceCurrent: () => source.isConnected && source.textContent === original,
  }).catch((error) => error)
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
  source.textContent = "Edited while preparing context"
  finish("The already-issued summary completed once")
  expect(await pending).toMatchObject({ name: "TranslationCancelledError" })
  expect(
    message.mock.calls.filter(([name]) => name === "getOrGenerateWebPageSummary"),
  ).toHaveLength(1)
  expect(message.mock.calls.filter(([name]) => name === "enqueueTranslateRequest")).toHaveLength(0)
})

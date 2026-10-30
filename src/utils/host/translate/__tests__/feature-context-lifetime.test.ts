// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { sendMessage } from "@/utils/message"
import { translateTextForInput, translateTextForPage } from "../translate-variants"
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
  it("keeps the real input pipeline running when the page session leaves their shared summary", async () => {
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
    ).toHaveLength(0)
    const execution = message.mock.calls.find(([name]) => name === "enqueueTranslateRequest")!
    expect(execution[1].sessionId).toBeUndefined()
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

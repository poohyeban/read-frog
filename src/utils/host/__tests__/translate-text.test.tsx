// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { NO_TRANSLATION_SENTINEL } from "@/utils/constants/prompt"
import { detectLanguage } from "@/utils/content/language"
import { Sha256Hex } from "@/utils/hash"
import { executeTranslate } from "@/utils/host/translate/execute-translate"
import { MIN_LENGTH_FOR_SKIP_LANGUAGE_DETECTION } from "@/utils/host/translate/translate-text"
import {
  translateTextForPage,
  translateTextForPageTitle,
} from "@/utils/host/translate/translate-variants"
import {
  beginPageTranslationSession,
  endPageTranslationSession,
} from "@/utils/host/translate/translation-session"
import { getTranslatePrompt } from "@/utils/prompts/translate"
import { isTranslationCancelledError } from "@/utils/request/cancellation"

// Mock dependencies
vi.mock("@/utils/config/storage", () => ({
  getLocalConfig: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/message", () => ({
  sendMessage: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/host/translate/api/deepl", () => ({
  deeplTranslate: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/host/translate/api/deeplx", () => ({
  deeplxTranslate: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/prompts/translate", () => ({
  getTranslatePrompt: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/content/language", () => ({
  detectLanguage: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/host/translate/webpage-context", () => ({
  getOrCreateWebPageContext: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/host/translate/webpage-summary", () => ({
  getOrGenerateWebPageSummary: vi.fn<(...args: any[]) => any>(),
}))

let mockSendMessage: any

let mockGetConfigFromStorage: any
let mockGetTranslatePrompt: any
let mockGetOrCreateWebPageContext: any
let mockGetOrGenerateWebPageSummary: any
let mockDetectLanguage: any

describe("translate-text", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    document.title = "Document Title"
    document.body.innerHTML = "<main>Body content</main>"
    mockSendMessage = vi.mocked((await import("@/utils/message")).sendMessage)

    mockGetConfigFromStorage = vi.mocked((await import("@/utils/config/storage")).getLocalConfig)
    mockGetTranslatePrompt = vi.mocked(
      (await import("@/utils/prompts/translate")).getTranslatePrompt,
    )
    mockGetOrCreateWebPageContext = vi.mocked(
      (await import("@/utils/host/translate/webpage-context")).getOrCreateWebPageContext,
    )
    mockGetOrGenerateWebPageSummary = vi.mocked(
      (await import("@/utils/host/translate/webpage-summary")).getOrGenerateWebPageSummary,
    )
    mockDetectLanguage = vi.mocked(detectLanguage)

    // Mock getOrCreateWebPageContext to return stable webpage metadata
    mockGetOrCreateWebPageContext.mockImplementation(() =>
      Promise.resolve({
        url: window.location.href,
        webTitle: document.title,
        webContent: document.body.textContent || "",
      }),
    )
    mockGetOrGenerateWebPageSummary.mockResolvedValue("Generated summary")

    // Mock getConfigFromStorage to return DEFAULT_CONFIG
    mockGetConfigFromStorage.mockResolvedValue(DEFAULT_CONFIG)

    // Mock getTranslatePrompt to return a simple prompt pair
    mockGetTranslatePrompt.mockResolvedValue({
      systemPrompt: "Translate to {{targetLang}}",
      prompt: "{{input}}",
    })
  })

  describe("translateTextForPage", () => {
    it("should send message with correct parameters", async () => {
      mockSendMessage.mockResolvedValue("translated text")

      const result = await translateTextForPage("test text")

      expect(result).toBe("translated text")
      const selectedProvider = DEFAULT_CONFIG.providersConfig.find(
        (provider) => provider.id === DEFAULT_CONFIG.pageTranslation.providerId,
      )!
      expect(mockSendMessage).toHaveBeenCalledWith(
        "enqueueTranslateRequest",
        expect.objectContaining({
          text: "test text",
          langConfig: DEFAULT_CONFIG.language,
          providerRef: { kind: "local", config: selectedProvider },
          scheduleAt: expect.any(Number),
          // LLM cache identity includes the actual prompts and context setting.
          hash: Sha256Hex(
            "test text",
            JSON.stringify(selectedProvider),
            DEFAULT_CONFIG.language.sourceCode,
            DEFAULT_CONFIG.language.targetCode,
            "Translate to {{targetLang}}",
            "{{input}}",
            "enableAIContentAware=false",
          ),
        }),
      )
      expect(mockGetOrCreateWebPageContext).toHaveBeenCalled()
      expect(mockGetOrGenerateWebPageSummary).not.toHaveBeenCalled()
    })

    it("forwards an explicit force-retranslation request without changing normal requests", async () => {
      mockSendMessage.mockResolvedValue("translated text")

      await translateTextForPage("hover text", "plain", {
        forceRetranslation: true,
      })
      await translateTextForPage("page text")

      const enqueueCalls = mockSendMessage.mock.calls.filter(
        ([type]: [string]) => type === "enqueueTranslateRequest",
      )
      expect(enqueueCalls).toHaveLength(2)
      expect(enqueueCalls[0][1]).toEqual(expect.objectContaining({ forceRetranslation: true }))
      expect(enqueueCalls[1][1].forceRetranslation).not.toBe(true)
    })

    it("maps a full no-translation sentinel response to an empty string", async () => {
      mockSendMessage.mockResolvedValue(NO_TRANSLATION_SENTINEL)

      const result = await translateTextForPage("test text")

      expect(result).toBe("")

      expect(
        mockSendMessage.mock.calls.filter(([type]: [string]) => type === "enqueueTranslateRequest"),
      ).toHaveLength(1)
    })

    it("returns a response containing the sentinel inside longer text verbatim", async () => {
      const mixed = `some translation ${NO_TRANSLATION_SENTINEL}`
      mockSendMessage.mockResolvedValue(mixed)

      const result = await translateTextForPage("test text")

      expect(result).toBe(mixed)
    })

    it("skips target-language text before sending a translation request by default", async () => {
      mockDetectLanguage.mockResolvedValueOnce(DEFAULT_CONFIG.language.targetCode)

      const targetLanguageText =
        "这是一个已经使用目标语言写成的较长段落，用于触发翻译前目标语言检测并跳过请求，同时确保文本长度超过检测阈值。"
      const result = await translateTextForPage(targetLanguageText)

      expect(result).toBe("")
      expect(mockDetectLanguage).toHaveBeenCalledWith(targetLanguageText, {})
      expect(mockSendMessage).not.toHaveBeenCalled()
    })

    it("sends the translation request when target-language precheck is disabled", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        pageTranslation: {
          ...DEFAULT_CONFIG.pageTranslation,
          page: {
            ...DEFAULT_CONFIG.pageTranslation.page,
            enableTargetLanguageSkip: false,
          },
        },
      }
      mockGetConfigFromStorage.mockResolvedValue(config)
      mockSendMessage.mockResolvedValue("translated text")

      const targetLanguageText =
        "这是一个已经使用目标语言写成的较长段落，但关闭预检测后仍然应该发送翻译请求，同时确保文本长度超过检测阈值。"
      const result = await translateTextForPage(targetLanguageText)

      expect(result).toBe("translated text")
      expect(mockDetectLanguage).not.toHaveBeenCalled()
      expect(mockSendMessage).toHaveBeenCalledWith(
        "enqueueTranslateRequest",
        expect.objectContaining({
          text: targetLanguageText,
        }),
      )
    })

    it("keeps explicit skipLanguages behavior when target-language precheck is disabled", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        pageTranslation: {
          ...DEFAULT_CONFIG.pageTranslation,
          page: {
            ...DEFAULT_CONFIG.pageTranslation.page,
            enableTargetLanguageSkip: false,
            skipLanguages: ["jpn"],
          },
        },
      }
      mockGetConfigFromStorage.mockResolvedValue(config)
      mockDetectLanguage.mockResolvedValueOnce("jpn")

      const japaneseText =
        "これは日本語で書かれた十分に長い段落で、明示的なスキップ言語の設定によって翻訳前にスキップされます。"
      const result = await translateTextForPage(japaneseText)

      expect(result).toBe("")
      expect(mockDetectLanguage).toHaveBeenCalledWith(japaneseText, {
        minLength: MIN_LENGTH_FOR_SKIP_LANGUAGE_DETECTION,
      })
      expect(mockSendMessage).not.toHaveBeenCalled()
    })

    // #1881: the session id is captured at pipeline ENTRY, but requests race
    // the awaits below (config, summary). If the user cancels mid-request the
    // request must NOT be dispatched — otherwise it lands unscoped (or after
    // the session's cancel drain) and becomes permanently uncancellable.
    describe("session cancellation gate", () => {
      afterEach(() => {
        endPageTranslationSession()
      })

      it("sends with the captured sessionId while the session stays active", async () => {
        mockSendMessage.mockResolvedValue("translated text")
        const sessionId = beginPageTranslationSession()

        await translateTextForPage("test text")

        expect(mockSendMessage).toHaveBeenCalledWith(
          "enqueueTranslateRequest",
          expect.objectContaining({ sessionId }),
        )
      })

      it("aborts without dispatching when the session ends mid-request", async () => {
        mockSendMessage.mockResolvedValue("translated text")
        beginPageTranslationSession()
        // getLocalConfig is awaited after the session id is captured; ending the
        // session here mimics a user cancel landing mid-request.
        mockGetConfigFromStorage.mockImplementation(async () => {
          endPageTranslationSession()
          return DEFAULT_CONFIG
        })

        let caught: unknown
        try {
          await translateTextForPage("test text")
        } catch (error) {
          caught = error
        }

        expect(isTranslationCancelledError(caught)).toBe(true)
        expect(mockSendMessage).not.toHaveBeenCalled()
      })

      it("aborts when a new session replaces the captured one mid-request", async () => {
        mockSendMessage.mockResolvedValue("translated text")
        beginPageTranslationSession()
        mockGetConfigFromStorage.mockImplementation(async () => {
          // restart(): old session ends, a new one begins.
          endPageTranslationSession()
          beginPageTranslationSession()
          return DEFAULT_CONFIG
        })

        let caught: unknown
        try {
          await translateTextForPage("test text")
        } catch (error) {
          caught = error
        }

        expect(isTranslationCancelledError(caught)).toBe(true)
        expect(mockSendMessage).not.toHaveBeenCalled()
      })
    })
  })

  describe("translateTextForPageTitle", () => {
    it("should use the latest original title instead of document.title when building webpage context", async () => {
      const llmConfig = {
        ...DEFAULT_CONFIG,
        pageTranslation: {
          ...DEFAULT_CONFIG.pageTranslation,
          providerId: "openai-default",
          enableAIContentAware: false,
        },
      }

      mockGetConfigFromStorage.mockResolvedValue(llmConfig)
      mockSendMessage.mockImplementation(async (type: string) => {
        if (type === "enqueueTranslateRequest") {
          return "translated page title"
        }
        return undefined
      })
      document.title = "Translated Browser Title"

      const result = await translateTextForPageTitle("Source Title To Translate")

      expect(result).toBe("translated page title")
      expect(mockSendMessage).toHaveBeenCalledWith(
        "enqueueTranslateRequest",
        expect.objectContaining({
          text: "Source Title To Translate",
          webTitle: "Source Title To Translate",
          webContent: undefined,
        }),
      )
      expect(mockGetOrCreateWebPageContext).not.toHaveBeenCalled()
      expect(mockGetOrGenerateWebPageSummary).not.toHaveBeenCalled()
    })

    it("should include webpage content for AI-aware title translation", async () => {
      const llmConfig = {
        ...DEFAULT_CONFIG,
        pageTranslation: {
          ...DEFAULT_CONFIG.pageTranslation,
          providerId: "openai-default",
          enableAIContentAware: true,
        },
      }

      mockGetConfigFromStorage.mockResolvedValue(llmConfig)
      mockSendMessage.mockImplementation(async (type: string) => {
        if (type === "enqueueTranslateRequest") {
          return "translated page title"
        }
        return undefined
      })

      const result = await translateTextForPageTitle("Source Title To Translate")

      expect(result).toBe("translated page title")
      expect(mockGetOrCreateWebPageContext).toHaveBeenCalledTimes(1)
      expect(mockGetOrGenerateWebPageSummary).not.toHaveBeenCalled()
      expect(mockSendMessage).toHaveBeenCalledWith(
        "enqueueTranslateRequest",
        expect.objectContaining({
          text: "Source Title To Translate",
          webTitle: "Source Title To Translate",
          webContent: "Body content",
          webSummary: undefined,
        }),
      )
    })

    it("should forward document.title to regular page translations", async () => {
      const llmConfig = {
        ...DEFAULT_CONFIG,
        pageTranslation: {
          ...DEFAULT_CONFIG.pageTranslation,
          providerId: "openai-default",
          enableAIContentAware: false,
        },
      }

      mockGetConfigFromStorage.mockResolvedValue(llmConfig)
      mockSendMessage.mockImplementation(async (type: string) => {
        if (type === "enqueueTranslateRequest") {
          return "translated body text"
        }
        return undefined
      })
      document.title = "Translated Browser Title"

      const result = await translateTextForPage("Body text")

      expect(result).toBe("translated body text")
      expect(mockSendMessage).toHaveBeenCalledWith(
        "enqueueTranslateRequest",
        expect.objectContaining({
          text: "Body text",
          webTitle: "Translated Browser Title",
        }),
      )
    })
  })

  describe("executeTranslate", () => {
    const langConfig = {
      sourceCode: "eng" as const,
      targetCode: "cmn" as const,
      detectedCode: "eng" as const,
      level: "intermediate" as const,
    }

    const providerConfig = {
      id: "openai-test",
      name: "OpenAI",
      enabled: true,
      provider: "openai" as const,
      apiKey: "test-key",
      model: { model: "gpt-5-mini" as const, isCustomModel: false, customModel: null },
    }

    it("should return empty string for empty/whitespace input", async () => {
      expect(await executeTranslate("", langConfig, providerConfig, getTranslatePrompt)).toBe("")
      expect(await executeTranslate(" ", langConfig, providerConfig, getTranslatePrompt)).toBe("")
      expect(await executeTranslate("\n", langConfig, providerConfig, getTranslatePrompt)).toBe("")
      expect(await executeTranslate(" \n ", langConfig, providerConfig, getTranslatePrompt)).toBe(
        "",
      )
      expect(await executeTranslate(" \n \t", langConfig, providerConfig, getTranslatePrompt)).toBe(
        "",
      )
    })
  })
})

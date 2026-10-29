import type { LLMProviderConfig } from "@/types/config/provider"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getRequestErrorMeta } from "@/utils/request/retry-policy"
import { aiTranslate } from "../ai"

const mocks = vi.hoisted(() => ({
  generateText: vi.fn<(...args: any[]) => any>(),
  getModelById: vi.fn<(...args: any[]) => any>(),
  getLanguageModelForConfig: vi.fn<(...args: any[]) => any>(),
  resolveModelId: vi.fn<(...args: any[]) => any>(),
  getProviderOptionsWithOverride: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("ai", () => ({
  generateText: mocks.generateText,
}))

vi.mock("@/utils/providers/model", () => ({
  getModelById: mocks.getModelById,
  getLanguageModelForConfig: mocks.getLanguageModelForConfig,
}))

vi.mock("@/utils/providers/model-id", () => ({
  resolveModelId: mocks.resolveModelId,
}))

vi.mock("@/utils/providers/options", () => ({
  getProviderOptionsWithOverride: mocks.getProviderOptionsWithOverride,
}))

const providerConfig: LLMProviderConfig = {
  id: "openai-default",
  name: "OpenAI",
  provider: "openai",
  enabled: true,
  apiKey: "sk-test",
  model: { model: "gpt-5-mini", isCustomModel: false, customModel: null },
}

const promptResolver = vi.fn<(...args: any[]) => any>().mockResolvedValue({
  systemPrompt: "system",
  prompt: "prompt",
})

describe("aiTranslate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getModelById.mockResolvedValue("newly-configured-model")
    mocks.getLanguageModelForConfig.mockReturnValue("captured-model")
    mocks.resolveModelId.mockReturnValue("gpt-5-mini")
    mocks.getProviderOptionsWithOverride.mockReturnValue({})
  })

  it("executes the captured provider rather than rereading an edited provider by ID", async () => {
    mocks.generateText.mockResolvedValue({ text: "translated" })
    await aiTranslate("hello", "Chinese", providerConfig, promptResolver)
    expect(mocks.getModelById).not.toHaveBeenCalled()
    expect(mocks.getLanguageModelForConfig).toHaveBeenCalledWith(providerConfig)
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "captured-model",
        maxRetries: 0,
      }),
    )
  })

  it("preserves AI SDK error metadata for retry policy decisions", async () => {
    const rateLimitedError = Object.assign(new Error("Too Many Requests"), {
      statusCode: 429,
      isRetryable: true,
      responseHeaders: {
        "retry-after": "2",
      },
    })
    mocks.generateText.mockRejectedValue(rateLimitedError)

    const error = await aiTranslate("hello", "Chinese", providerConfig, promptResolver).catch(
      (caughtError) => caughtError,
    )

    expect(error).toBe(rateLimitedError)
    expect(getRequestErrorMeta(error)).toEqual(
      expect.objectContaining({
        statusCode: 429,
        isRetryable: true,
        retryAfterMs: 2000,
        kind: "rate-limit",
      }),
    )
  })

  it("does not expose a remote error body as the display message", async () => {
    const responseBody = '{"code":404,"message":"模型 Kimi-K2-Instruct-09051 无效","data":{}}'
    const invalidModelError = Object.assign(new Error("Something went wrong"), {
      statusCode: 404,
      isRetryable: false,
      responseBody,
    })
    mocks.generateText.mockRejectedValue(invalidModelError)

    const error = await aiTranslate("hello", "Chinese", providerConfig, promptResolver).catch(
      (caughtError) => caughtError,
    )

    expect(error).toBe(invalidModelError)
    expect(error.message).toBe("Provider request failed (HTTP 404). Check the configured service.")
    expect(error.message).not.toContain(responseBody)
    expect(getRequestErrorMeta(error)).toEqual(
      expect.objectContaining({
        statusCode: 404,
        isRetryable: false,
        kind: "bad-request",
      }),
    )
  })
})

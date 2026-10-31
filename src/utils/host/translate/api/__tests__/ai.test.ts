import type { LLMProviderConfig } from "@/types/config/provider"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getRequestErrorMeta } from "@/utils/request/retry-policy"
import { SubtitleWorkRejected } from "@/utils/subtitles/work-policy"
import { aiTranslate } from "../ai"

const mocks = vi.hoisted(() => ({
  generateText: vi.fn<(...args: any[]) => any>(),
  getLanguageModelForConfig: vi.fn<(...args: any[]) => any>(),
  resolveModelId: vi.fn<(...args: any[]) => any>(),
  getProviderOptionsWithOverride: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("ai", () => ({
  generateText: mocks.generateText,
}))

vi.mock("@/utils/providers/resource-runtime", () => ({
  runProviderOperation: async (
    _provider: unknown,
    signal: AbortSignal | undefined,
    run: Function,
    beforeSend?: () => void,
  ) => {
    beforeSend?.()
    return run(signal, { physicalRequestId: "mock", start: () => {} })
  },
}))

vi.mock("@/utils/providers/model", () => ({
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
    mocks.getLanguageModelForConfig.mockReturnValue("model")
    mocks.resolveModelId.mockReturnValue("gpt-5-mini")
    mocks.getProviderOptionsWithOverride.mockReturnValue({})
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

  it("reserves the actual rendered input before dispatch and records returned usage with SDK retries disabled", async () => {
    const order: string[] = []
    const usage = { inputTokens: 10, outputTokens: 20 }
    const guard = {
      beforeCall: vi.fn<(input: string, output: number) => Promise<void>>(async () => {
        order.push("reserve")
      }),
      onDispatch: () => {
        order.push("dispatch")
      },
      usage: vi.fn<(value: { inputTokens?: number; outputTokens?: number }) => Promise<void>>(
        async () => {},
      ),
    }
    mocks.generateText.mockImplementation(async () => {
      order.push("model")
      return { text: "translated", usage, finishReason: "stop" }
    })
    await aiTranslate("hello", "Chinese", providerConfig, promptResolver, {
      modelGuard: guard,
      maxOutputTokens: 128,
    })
    expect(order).toEqual(["reserve", "dispatch", "model"])
    expect(guard.beforeCall).toHaveBeenCalledWith("system\nprompt", 128)
    expect(guard.usage).toHaveBeenCalledWith(usage)
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0, maxOutputTokens: 128 }),
    )
  })

  it("a lease revoked at the final dispatch checkpoint causes zero SDK starts", async () => {
    const guard = {
      beforeCall: async () => {},
      usage: async () => {},
      onDispatch: () => {
        throw new SubtitleWorkRejected("lease")
      },
    }
    await expect(
      aiTranslate("hello", "Chinese", providerConfig, promptResolver, {
        modelGuard: guard,
        maxOutputTokens: 128,
      }),
    ).rejects.toThrow("lease")
    expect(mocks.generateText).not.toHaveBeenCalled()
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

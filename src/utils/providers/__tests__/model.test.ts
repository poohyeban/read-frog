import { beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"

let getStorageItemMock: ReturnType<typeof vi.fn>

const {
  anthropicLanguageModelMock,
  azureChatModelMock,
  azureLanguageModelMock,
  openAICompatibleLanguageModelMock,
  openResponsesLanguageModelMock,
  ollamaLanguageModelMock,

  createOllamaMock,
  createOpenAICompatibleMock,
} = vi.hoisted(() => {
  const innerAnthropicLanguageModelMock = vi.fn<(...args: any[]) => any>()
  const innerAzureChatModelMock = vi.fn<(...args: any[]) => any>()
  const innerAzureLanguageModelMock = vi.fn<(...args: any[]) => any>()
  const innerOpenAICompatibleLanguageModelMock = vi.fn<(...args: any[]) => any>()
  const innerOpenResponsesLanguageModelMock = vi.fn<(...args: any[]) => any>()
  const innerOllamaLanguageModelMock = vi.fn<(...args: any[]) => any>()
  const innerCreateAnthropicMock = vi.fn<(...args: any[]) => any>(
    (_options?: Record<string, unknown>) => ({
      languageModel: innerAnthropicLanguageModelMock,
    }),
  )
  const innerCreateAzureMock = vi.fn<(...args: any[]) => any>(
    (_options?: Record<string, unknown>) => ({
      chat: innerAzureChatModelMock,
      languageModel: innerAzureLanguageModelMock,
    }),
  )
  const innerCreateOpenAICompatibleMock = vi.fn<(...args: any[]) => any>(
    (_options?: Record<string, unknown>) => ({
      languageModel: innerOpenAICompatibleLanguageModelMock,
    }),
  )
  const innerCreateOpenResponsesMock = vi.fn<(...args: any[]) => any>(
    (_options?: Record<string, unknown>) => ({
      languageModel: innerOpenResponsesLanguageModelMock,
    }),
  )
  const innerCreateOllamaMock = vi.fn<(...args: any[]) => any>(
    (_options?: Record<string, unknown>) => ({
      languageModel: innerOllamaLanguageModelMock,
    }),
  )

  return {
    anthropicLanguageModelMock: innerAnthropicLanguageModelMock,
    azureChatModelMock: innerAzureChatModelMock,
    azureLanguageModelMock: innerAzureLanguageModelMock,
    openAICompatibleLanguageModelMock: innerOpenAICompatibleLanguageModelMock,
    openResponsesLanguageModelMock: innerOpenResponsesLanguageModelMock,
    ollamaLanguageModelMock: innerOllamaLanguageModelMock,
    createAnthropicMock: innerCreateAnthropicMock,
    createAzureMock: innerCreateAzureMock,
    createOllamaMock: innerCreateOllamaMock,
    createOpenAICompatibleMock: innerCreateOpenAICompatibleMock,
    createOpenResponsesMock: innerCreateOpenResponsesMock,
  }
})

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}))

vi.mock("ai-sdk-ollama", () => ({
  createOllama: createOllamaMock,
}))

function createOllamaProviderConfig(providerOptions?: Record<string, unknown>) {
  return {
    id: "ollama-default",
    name: "Ollama",
    enabled: true,
    provider: "ollama",
    baseURL: "http://127.0.0.1:11434/",
    model: {
      model: "gemma3:4b",
      isCustomModel: false,
      customModel: null,
    },
    ...(providerOptions !== undefined && { providerOptions }),
  }
}

describe("getModelById", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    anthropicLanguageModelMock.mockReturnValue("anthropic-model")
    azureChatModelMock.mockReturnValue("azure-chat-model")
    azureLanguageModelMock.mockReturnValue("azure-model")
    openAICompatibleLanguageModelMock.mockReturnValue("custom-model")
    openResponsesLanguageModelMock.mockReturnValue("custom-responses-model")
    ollamaLanguageModelMock.mockReturnValue("ollama-model")
    getStorageItemMock = vi.fn<(...args: any[]) => any>()
    ;(storage.getItem as unknown as ReturnType<typeof vi.fn>) = getStorageItemMock
  })

  it("passes Ollama root base URL and disables think on the language model", async () => {
    getStorageItemMock.mockResolvedValue({
      providersConfig: [createOllamaProviderConfig({ think: true })],
    })

    const { getModelById } = await import("../model")
    const result = await getModelById("ollama-default")

    expect(result).toBe("ollama-model")
    expect(createOllamaMock).toHaveBeenCalledWith({
      baseURL: "http://127.0.0.1:11434/",
      fetch: expect.any(Function),
    })
    expect(ollamaLanguageModelMock).toHaveBeenCalledWith("gemma3:4b", { think: false })
  })

  it("passes custom headers for OpenAI-compatible providers", async () => {
    getStorageItemMock.mockResolvedValue({
      providersConfig: [
        {
          id: "custom-openai",
          name: "Custom Provider",
          enabled: true,
          provider: "openai-compatible",
          apiKey: "custom-key",
          baseURL: "http://127.0.0.1:1234/v1",
          model: {
            model: "use-custom-model",
            isCustomModel: true,
            customModel: "huihui-hy-mt1.5-1.8b-abliterated",
          },
          headers: {
            "HTTP-Referer": "https://example.com",
            "X-Title": "Read Frog",
          },
        },
      ],
    })

    const { getModelById } = await import("../model")
    const result = await getModelById("custom-openai")

    expect(result).toBe("custom-model")
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "openai-compatible",
        baseURL: "http://127.0.0.1:1234/v1",
        apiKey: "custom-key",
        headers: {
          "HTTP-Referer": "https://example.com",
          "X-Title": "Read Frog",
        },
      }),
    )
    expect(openAICompatibleLanguageModelMock).toHaveBeenCalledWith(
      "huihui-hy-mt1.5-1.8b-abliterated",
    )
  })
})

import { generateText, Output } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { llmProviderConfigItemSchema } from "@/types/config/provider"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { resolveResourcePolicy } from "@/utils/request/resource-policy"
import { ResourceScheduler } from "@/utils/request/resource-scheduler"
import { getLanguageModelForConfig } from "../model"

async function scheduled(
  provider: Parameters<typeof getLanguageModelForConfig>[0],
  options: Record<string, unknown>,
) {
  const scheduler = new ResourceScheduler()
  scheduler.configure(
    [{ id: "test", policy: resolveResourcePolicy() }],
    new Map([["test", ["test"]]]),
  )
  return scheduler.run({ resourceId: "test", consumer: "test" }, async (signal, permit) =>
    generateText({
      prompt: "Test",
      ...options,
      model: getLanguageModelForConfig(provider, permit),
      abortSignal: signal,
      maxRetries: 0,
    }),
  )
}

const secret = "lite-test-key-never-a-real-credential"

describe("direct user-configured provider requests", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("keeps OpenAI structured output on the existing Responses SDK path", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Intentional test rejection" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      scheduled(
        { ...DEFAULT_PROVIDER_CONFIG.openai, apiKey: secret },
        {
          prompt: "Explain this word",
          output: Output.object({ schema: z.object({ definition: z.string() }) }),
          maxRetries: 0,
        },
      ),
    ).rejects.toBeInstanceOf(Error)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.openai.com/v1/responses")
    if (typeof init?.body !== "string") throw new Error("Expected a JSON request")
    expect(JSON.parse(init.body)).toMatchObject({
      text: {
        format: {
          type: "json_schema",
          strict: true,
          schema: { properties: { definition: { type: "string" } } },
        },
      },
    })
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" })
  })

  it.each(["openai", "openai-compatible", "google", "ollama", "deepseek"] as const)(
    "%s sends credentials and text only to its configured endpoint",
    async (provider) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Intentional test rejection" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      )
      vi.stubGlobal("fetch", fetchMock)
      const config = llmProviderConfigItemSchema.parse({
        ...DEFAULT_PROVIDER_CONFIG[provider],
        apiKey: secret,
        baseURL: "https://user-api.example/v1",
        model: {
          ...DEFAULT_PROVIDER_CONFIG[provider].model,
          isCustomModel: true,
          customModel: "test-model",
        },
      })
      await expect(
        scheduled(config, {
          prompt: "Translate this test sentence.",
          maxRetries: 0,
        }),
      ).rejects.toBeInstanceOf(Error)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [input, init] = fetchMock.mock.calls[0]!
      const url = new URL(input instanceof Request ? input.url : String(input))
      expect(url.origin).toBe("https://user-api.example")
      expect(init?.redirect).toBe("error")
      expect(init?.credentials).toBe("omit")
      expect(url.pathname).toMatch(/^\/v1\//)
      const headers = new Headers(init?.headers)
      expect(
        provider === "google" ? headers.get("x-goog-api-key") : headers.get("authorization"),
      ).toBe(provider === "google" ? secret : `Bearer ${secret}`)
      expect(init?.body).toContain("Translate this test sentence.")
      expect(init?.body).not.toContain(secret)
      expect(url.href).not.toContain(secret)
    },
  )
})

import { afterEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { runStructuredObjectStreamInBackground } from "@/entrypoints/background/background-stream"
import { DEFAULT_CONFIG, CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { getProviderOptionsWithOverride } from "../options"

function sseResponse(output: Record<string, unknown>) {
  const parts = [
    {
      index: 0,
      delta: { role: "assistant", reasoning_content: "fixture reasoning" },
      finish_reason: null,
    },
    { index: 0, delta: { content: JSON.stringify(output) }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: "stop" },
  ]
  return new Response(
    parts
      .map(
        (choice) =>
          `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [choice] })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n",
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("dedicated DeepSeek structured streaming", () => {
  async function setup(output: Record<string, unknown>) {
    const provider = {
      ...DEFAULT_PROVIDER_CONFIG.deepseek,
      apiKey: "test-secret",
      enabled: true,
      baseURL: "https://user-api.example/v1",
    }
    await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, {
      ...DEFAULT_CONFIG,
      providersConfig: DEFAULT_CONFIG.providersConfig.map((p) =>
        p.id === provider.id ? provider : p,
      ),
    })
    await storage.setItem("local:performanceOverrides", {
      version: 1,
      revision: 1,
      providers: { [provider.id]: { maxAttempts: 1 } },
    })
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => sseResponse(output))
    vi.stubGlobal("fetch", fetchMock)
    return { provider, fetchMock }
  }

  it("uses JSON mode plus a schema prompt and returns validated action output", async () => {
    const { provider, fetchMock } = await setup({
      definition: "awkward or cumbersome",
      difficulty: 2,
    })
    const result = await runStructuredObjectStreamInBackground({
      providerId: provider.id,
      prompt: "Explain clunky",
      outputSchema: [
        { name: "definition", type: "string" },
        { name: "difficulty", type: "number" },
      ],
      providerOptions: getProviderOptionsWithOverride("deepseek-flash", "deepseek", {
        thinking: { type: "disabled" },
      }),
    })
    expect(result.output).toEqual({ definition: "awkward or cumbersome", difficulty: 2 })
    expect(result.thinking.status).toBe("complete")
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://user-api.example/v1/chat/completions")
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" })
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-secret")
    if (typeof init?.body !== "string") throw new Error("Expected a JSON body")
    const request = JSON.parse(init.body)
    expect(request).toMatchObject({
      model: "deepseek-flash",
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    })
    expect(request.response_format).not.toHaveProperty("json_schema")
    expect(request.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining('"definition"'),
        }),
      ]),
    )
    expect(init.body).not.toContain("test-secret")
  })

  it("still rejects invalid model output instead of silently accepting arbitrary JSON", async () => {
    const { provider } = await setup({ definition: 42 })
    await expect(
      runStructuredObjectStreamInBackground({
        providerId: provider.id,
        prompt: "Explain clunky",
        outputSchema: [{ name: "definition", type: "string" }],
      }),
    ).rejects.toThrow("AI output does not match the expected format")
  })
})

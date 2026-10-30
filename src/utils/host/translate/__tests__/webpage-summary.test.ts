// @vitest-environment jsdom

import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/utils/message", () => ({
  sendMessage: vi.fn<(...args: any[]) => any>(),
}))

const localRef: PromptableProviderRef = {
  kind: "local",
  config: {
    id: "openai-default",
    name: "OpenAI",
    provider: "openai",
    enabled: true,
    apiKey: "sk-test",
    model: { model: "gpt-5-mini", isCustomModel: false, customModel: null },
  } as never,
}

const webPageContext = {
  url: "https://example.com/article",
  webTitle: "Page title",
  webContent: "Page body",
}

describe("getOrGenerateWebPageSummary", () => {
  it("skips the round trip when AI content awareness is off or context is empty", async () => {
    const { sendMessage } = await import("@/utils/message")
    vi.mocked(sendMessage).mockClear()

    const { getOrGenerateWebPageSummary } = await import("../webpage-summary")
    await expect(getOrGenerateWebPageSummary(webPageContext, localRef, false)).resolves.toBeNull()
    await expect(getOrGenerateWebPageSummary(null, localRef, true)).resolves.toBeNull()
    await expect(
      getOrGenerateWebPageSummary({ ...webPageContext, webContent: "  " }, localRef, true),
    ).resolves.toBeNull()

    expect(sendMessage).not.toHaveBeenCalled()
  })
  it("sends one summary message for 30 page consumers and reuses completion", async () => {
    const { sendMessage } = await import("@/utils/message")
    const { getOrGenerateWebPageSummary, releaseWebPageSummaries } =
      await import("../webpage-summary")
    releaseWebPageSummaries()
    vi.mocked(sendMessage).mockClear().mockResolvedValue("Shared summary")
    const results = await Promise.all(
      Array.from({ length: 30 }, () => getOrGenerateWebPageSummary(webPageContext, localRef, true)),
    )
    expect(new Set(results)).toEqual(new Set(["Shared summary"]))
    await expect(getOrGenerateWebPageSummary(webPageContext, localRef, true)).resolves.toBe(
      "Shared summary",
    )
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})

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
    await expect(
      getOrGenerateWebPageSummary(webPageContext, localRef, false, "pageTranslation"),
    ).resolves.toBeNull()
    await expect(
      getOrGenerateWebPageSummary(null, localRef, true, "pageTranslation"),
    ).resolves.toBeNull()
    await expect(
      getOrGenerateWebPageSummary(
        { ...webPageContext, webContent: "  " },
        localRef,
        true,
        "pageTranslation",
      ),
    ).resolves.toBeNull()

    expect(sendMessage).not.toHaveBeenCalled()
  })
})

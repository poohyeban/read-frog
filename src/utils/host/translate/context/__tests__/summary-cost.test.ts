import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { releaseWebPageContext } from "../../webpage-context"
import { getOrGenerateWebPageSummary, releaseWebPageSummaries } from "../../webpage-summary"
const message = vi.hoisted(() => vi.fn<(...args: any[]) => any>())
vi.mock("@/utils/message", () => ({ sendMessage: message }))
const provider: PromptableProviderRef = {
  kind: "local",
  config: {
    id: "summary-fixture",
    name: "Summary fixture",
    enabled: true,
    provider: "openai-compatible",
    baseURL: "https://fixture.invalid/v1",
    model: { model: "use-custom-model", isCustomModel: true, customModel: "mock" },
  },
}
const context = (text: string, truncated = false) => ({
  url: location.href,
  webTitle: "Source title",
  webContent: text,
  scopeType: "FeedItem" as const,
  provenance: {
    confidence: "semantic" as const,
    collection: true,
    locator: "",
    truncated,
    createdAt: 0,
    summary: "none" as const,
  },
})
const summary = getOrGenerateWebPageSummary

beforeEach(() => {
  message.mockReset().mockResolvedValue("Model-generated summary")
})
afterEach(() => {
  releaseWebPageSummaries()
  releaseWebPageContext()
})
it("uses complete short source context for 100 feed items with zero summary RPCs", async () => {
  for (let i = 0; i < 100; i++)
    expect(await summary(context(`Source ${i}`), provider, true)).toBe(`Source ${i}`)
  expect(message).not.toHaveBeenCalled()
})
it("retains explicit model-summary capability and shares equal requests", async () => {
  const values = await Promise.all(
    Array.from({ length: 30 }, () =>
      summary(context("Same source"), provider, true, null, { requireModel: true }),
    ),
  )
  expect(new Set(values)).toEqual(new Set(["Model-generated summary"]))
  expect(message).toHaveBeenCalledTimes(1)
})
it("bounds automatic long-feed summary fanout and requires explicit admission for another source", async () => {
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      summary(context(`Long source ${i}`, true), provider, true).catch((error: unknown) => error),
    ),
  )
  expect(message).toHaveBeenCalledTimes(1)
  const errors = results.filter((result) => result instanceof Error)
  expect(errors).toHaveLength(99)
  expect(errors[0]).toMatchObject({ code: "CONTEXT_SUMMARY_CONSENT_REQUIRED" })
  const error = errors[0] as Error & { authorize: () => void }
  error.authorize()
  expect(await summary(context("Long source 1", true), provider, true)).toBe(
    "Model-generated summary",
  )
  expect(message).toHaveBeenCalledTimes(2)
})

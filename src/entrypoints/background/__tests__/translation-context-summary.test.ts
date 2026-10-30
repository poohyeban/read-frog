import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { generateArticleSummary, ARTICLE_SUMMARY_RULE_VERSION } from "@/utils/content/summary"
import { RequestQueue } from "@/utils/request/request-queue"
import { getOrGenerateTranslationContextSummary } from "../translation-context-summary"

const mocks = vi.hoisted(() => ({
  generate: vi.fn<(...args: any[]) => any>(),
  get: vi.fn<(...args: any[]) => any>(),
  put: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("../background-stream", () => ({ generateTextForProviderRef: mocks.generate }))
vi.mock("@/utils/db/dexie/db", () => ({
  db: { articleSummaryCache: { get: mocks.get, put: mocks.put } },
}))
const providerRef = {
  kind: "local",
  config: {
    id: "test",
    provider: "openai",
    enabled: true,
    name: "Test",
    model: { model: "gpt-4o", isCustomModel: false, customModel: null },
  },
} as PromptableProviderRef

function setup() {
  const requestQueue = new RequestQueue({
    rate: 100,
    capacity: 100,
    timeoutMs: 5000,
    maxRetries: 2,
    baseRetryDelayMs: 100,
  })
  const cancelled = new Set<string>()
  const run = (scope = "1:a", cacheKeyParts = ["title", "body"]) =>
    getOrGenerateTranslationContextSummary({
      title: "title",
      textContent: "body",
      providerRef,
      cacheKeyParts,
      requestQueue,
      scope,
      isScopeCancelled: (key) => cancelled.has(key),
    })
  const cancel = (scope: string) => {
    cancelled.add(scope)
    requestQueue.cancelByScope(scope)
  }
  return { run, cancel }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.get.mockResolvedValue(undefined)
  mocks.put.mockResolvedValue(undefined)
  mocks.generate.mockResolvedValue("A complete summary.")
})
afterEach(() => vi.useRealTimers())

describe("article context queue integration", () => {
  it("shares 30 consumers and persists only a successful versioned result", async () => {
    const { run } = setup()
    await Promise.all(Array.from({ length: 30 }, () => run()))
    expect(mocks.generate).toHaveBeenCalledTimes(1)
    expect(mocks.put).toHaveBeenCalledTimes(1)
    const row = mocks.put.mock.calls[0]![0]
    mocks.get.mockResolvedValue(row)
    await expect(run()).resolves.toBe(row.summary)
    expect(mocks.generate).toHaveBeenCalledTimes(1)
    expect(ARTICLE_SUMMARY_RULE_VERSION).toBeTruthy()
    expect(mocks.generate.mock.calls[0]![0]).toMatchObject({ maxRetries: 0, maxOutputTokens: 2048 })
  })
  it("propagates the original 429 metadata and honors Retry-After through repeated queue retries", async () => {
    const error = Object.assign(new Error("rate limited"), {
      statusCode: 429,
      responseHeaders: { "retry-after": "10" },
    })
    mocks.generate.mockRejectedValueOnce(error).mockRejectedValueOnce(error)
    const promise = setup().run()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.generate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9999)
    expect(mocks.generate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.generate).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(11000)
    await expect(promise).resolves.toBe("A complete summary.")
    expect(mocks.generate).toHaveBeenCalledTimes(3)
  })
  it("exhausts network retries before cooling down, then permits recovery", async () => {
    const error = new TypeError("Failed to fetch")
    mocks.generate.mockRejectedValue(error)
    const { run } = setup()
    const failed = run().catch((error) => error)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await failed).toBe(error)
    expect(mocks.generate).toHaveBeenCalledTimes(3)
    await expect(run()).rejects.toBe(error)
    expect(mocks.generate).toHaveBeenCalledTimes(3)
    expect(mocks.put).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30001)
    mocks.generate.mockResolvedValue("Recovered summary")
    await expect(run()).resolves.toBe("Recovered summary")
  })
  it("exhausts continuous 429s without persisting failure", async () => {
    const error = Object.assign(new Error("429"), { statusCode: 429 })
    mocks.generate.mockRejectedValue(error)
    const failed = setup()
      .run()
      .catch((error) => error)
    await vi.runAllTimersAsync()
    expect(await failed).toBe(error)
    expect(mocks.generate.mock.calls.length).toBeGreaterThan(2)
    expect(mocks.generate.mock.calls.length).toBeLessThanOrEqual(9)
    expect(mocks.put).not.toHaveBeenCalled()
  })
  it("keeps a shared request alive until its last scope leaves", async () => {
    let signal!: AbortSignal
    mocks.generate.mockImplementation((_payload, options) => {
      signal = options.signal
      return new Promise(() => {})
    })
    const { run, cancel } = setup()
    const first = run("1:a").catch((error) => error)
    const second = run("2:b").catch((error) => error)
    await vi.advanceTimersByTimeAsync(0)
    cancel("1:a")
    expect(signal.aborted).toBe(false)
    cancel("2:b")
    expect(signal.aborted).toBe(true)
    expect(await first).toMatchObject({ name: "TranslationCancelledError" })
    expect(await second).toMatchObject({ name: "TranslationCancelledError" })
    expect(mocks.put).not.toHaveBeenCalled()
  })
  it("returns success to the remaining scope after another cancels", async () => {
    let finish!: (text: string) => void
    mocks.generate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const { run, cancel } = setup()
    const first = run("1:a").catch((error) => error)
    const second = run("2:b")
    await vi.advanceTimersByTimeAsync(0)
    cancel("1:a")
    finish("Ready summary")
    expect(await first).toMatchObject({ name: "TranslationCancelledError" })
    await expect(second).resolves.toBe("Ready summary")
  })
  it("rejects cancelled cache lookups before enqueue", async () => {
    const { run, cancel } = setup()
    const failed = run().catch((error) => error)
    cancel("1:a")
    expect(await failed).toMatchObject({ name: "TranslationCancelledError" })
    expect(mocks.generate).not.toHaveBeenCalled()
  })
  it("distinguishes empty content, invalid output, and abort without swallowing errors", async () => {
    const generate = vi.fn<(...args: any[]) => any>().mockResolvedValue(" ")
    await expect(generateArticleSummary("t", "", { providerRef }, { generate })).resolves.toBeNull()
    await expect(
      generateArticleSummary("t", "body", { providerRef }, { generate }),
    ).rejects.toThrow("Invalid article summary")
    generate.mockResolvedValue("x".repeat(6001))
    await expect(
      generateArticleSummary("t", "body", { providerRef }, { generate }),
    ).rejects.toThrow("Invalid article summary")
    const controller = new AbortController()
    controller.abort()
    await expect(
      generateArticleSummary("t", "body", { providerRef }, { generate, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
  })
})

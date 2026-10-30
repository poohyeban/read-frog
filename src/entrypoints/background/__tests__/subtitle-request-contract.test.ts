import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { browser, storage } from "#imports"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { attachRequestErrorMeta } from "@/utils/request/retry-policy"
import { unwrapSubtitleResult, subtitleFailure } from "@/utils/subtitles/result"
import { createSubtitleTranslationPlan } from "@/utils/subtitles/translation-plan"
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (msg: any) => Promise<any>>(),
  get: vi.fn<(...args: any[]) => any>(),
  put: vi.fn<(...args: any[]) => any>(),
  execute: vi.fn<(...args: any[]) => any>(),
  generate: vi.fn<(...args: any[]) => any>(),
  config: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("@/utils/message", () => ({
  onMessage: (key: string, handler: any) => mocks.handlers.set(key, handler),
}))
vi.mock("../config", () => ({ ensureInitializedConfig: mocks.config }))
vi.mock("@/utils/host/translate/execute-translate", () => ({ executeTranslate: mocks.execute }))
vi.mock("../background-stream", () => ({ generateTextForProviderRef: mocks.generate }))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    translationCache: { get: mocks.get, put: mocks.put },
    aiSegmentationCache: {
      get: mocks.get,
      put: mocks.put,
      delete: vi.fn<(...args: any[]) => any>(),
    },
  },
}))
import { setupSubtitlesTranslationHandlers } from "../subtitles-translation"
const call = (type: string, data: any, tab = 7) =>
  mocks.handlers.get(type)!({ data, sender: { tab: { id: tab }, frameId: 0 } })
const plan = (sessionId = "scope") =>
  createSubtitleTranslationPlan({
    text: "hello",
    langConfig: DEFAULT_CONFIG.language,
    providerRef: { kind: "local", config: DEFAULT_PROVIDER_CONFIG.openai },
    promptConfig: DEFAULT_CONFIG.videoSubtitles,
    scheduleAt: 0,
    sessionId,
    glossaryTerms: [],
  }).request

describe("subtitle background contracts using real RequestQueue and BatchQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.config.mockResolvedValue(structuredClone(DEFAULT_CONFIG))
    mocks.get.mockResolvedValue(undefined)
    mocks.put.mockResolvedValue(undefined)
    storage.watch = vi.fn<(...args: any[]) => any>(() => () => {})
    browser.tabs.onRemoved.addListener = vi.fn<(...args: any[]) => any>()
    setupSubtitlesTranslationHandlers()
  })
  afterEach(() => vi.useRealTimers())
  it("passes an immutable prompt snapshot through batch execution without re-reading config", async () => {
    let built: any
    mocks.execute.mockImplementation(async (text, _lang, _provider, resolver, options) => {
      built = await resolver("Chinese", text, options)
      return "translation"
    })
    const request = plan()
    const result = call("enqueueSubtitlesTranslateRequest", request)
    await vi.advanceTimersByTimeAsync(101)
    expect(await result).toBe("translation")
    expect(built.prompt).toContain("hello")
    expect(mocks.config).toHaveBeenCalledTimes(1) // Queue setup only.
    expect(mocks.put).toHaveBeenCalledWith(
      expect.objectContaining({ key: request.hash, translation: "translation" }),
    )
  })
  it("ignores a different tab's cancellation, aborts the real model signal for its sender", async () => {
    let signal: AbortSignal | undefined
    mocks.execute.mockImplementation((_text, _lang, _provider, _resolver, options) => {
      signal = options.signal
      return new Promise(() => {})
    })
    const result = call("enqueueSubtitlesTranslateRequest", plan()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(101)
    expect(signal?.aborted).toBe(false)
    await call("cancelSubtitleRequests", { sessionId: "scope", tabId: 7 }, 8)
    expect(signal?.aborted).toBe(false)
    await call("cancelSubtitleRequests", { sessionId: "scope" }, 7)
    expect(signal?.aborted).toBe(true)
    expect((await result).name).toBe("TranslationCancelledError")
    expect(mocks.put).not.toHaveBeenCalled()
  })
  it("does not enqueue after cancellation during the cache lookup", async () => {
    let finish!: (cached: unknown) => void
    mocks.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const result = call("enqueueSubtitlesTranslateRequest", plan()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(0)
    await call("cancelSubtitleRequests", { sessionId: "scope" })
    finish(undefined)
    expect((await result).name).toBe("TranslationCancelledError")
    await vi.advanceTimersByTimeAsync(101)
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it("rejects a cache hash that does not match the request and skips queues for a cache hit", async () => {
    await expect(
      call("enqueueSubtitlesTranslateRequest", { ...plan(), hash: "wrong" }),
    ).rejects.toThrow("identity")
    mocks.get.mockResolvedValue({ translation: "cached" })
    expect(await call("enqueueSubtitlesTranslateRequest", plan())).toBe("cached")
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it("meters AI segmentation through the same queue with its own output budget and cancellation", async () => {
    let signal: AbortSignal | undefined
    mocks.generate.mockImplementation((_payload, options) => {
      signal = options.signal
      return new Promise(() => {})
    })
    const result = call("aiSegmentSubtitles", {
      jsonContent: JSON.stringify([{ s: 0, e: 1000, t: "hello" }]),
      providerRef: plan().providerRef,
      sessionId: "segment",
    }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 16384 }),
      expect.anything(),
    )
    await call("cancelSubtitleRequests", { sessionId: "segment" })
    expect(signal?.aborted).toBe(true)
    expect((await result).name).toBe("TranslationCancelledError")
    expect(mocks.put).not.toHaveBeenCalled()
  })
  it("returns validated segmentation cache immediately without a model call", async () => {
    const cached = "WEBVTT\n\n0 --> 1000\nhello"
    mocks.get.mockResolvedValue({ result: cached })
    expect(
      await call("aiSegmentSubtitles", {
        jsonContent: JSON.stringify([{ s: 0, e: 1000, t: "hello" }]),
        providerRef: { kind: "local", config: DEFAULT_PROVIDER_CONFIG.openai },
        sessionId: "cache",
      }),
    ).toBe(cached)
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.put).not.toHaveBeenCalled()
  })
  it("preserves permanent failure classification across a serialized message response", async () => {
    mocks.execute.mockRejectedValue(
      attachRequestErrorMeta(new Error("refused"), { statusCode: 401, isRetryable: false }),
    )
    const request = createSubtitleTranslationPlan({
      ...plan(),
      providerRef: { kind: "local", config: DEFAULT_PROVIDER_CONFIG.google },
      promptConfig: DEFAULT_CONFIG.videoSubtitles,
      resultFormat: "outcome",
    }).request
    const pending = call("enqueueSubtitlesTranslateRequest", request)
    await vi.advanceTimersByTimeAsync(101)
    const result = await pending
    const wire = JSON.parse(JSON.stringify(result))
    let received: unknown
    try {
      unwrapSubtitleResult(wire)
    } catch (error) {
      received = error
    }
    expect(subtitleFailure(received)).toMatchObject({ status: "permanent", message: "refused" })
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.put).not.toHaveBeenCalled()
  })
})

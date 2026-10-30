import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { browser, storage } from "#imports"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR } from "@/utils/constants/prompt"
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
    vi.resetAllMocks()
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
      expect.objectContaining({ key: expect.any(String), translation: "translation" }),
    )
    expect(mocks.put.mock.calls[0]![0].key).not.toBe(request.hash)
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
  it("does not call the provider after cancellation during the batch cache lookup", async () => {
    let finish!: (cached: unknown) => void
    mocks.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const result = call("enqueueSubtitlesTranslateRequest", plan()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(101)
    await call("cancelSubtitleRequests", { sessionId: "scope" })
    finish(undefined)
    expect((await result).name).toBe("TranslationCancelledError")
    await vi.advanceTimersByTimeAsync(101)
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it("rejects a mismatched admission hash and skips the provider for a batch cache hit", async () => {
    await expect(
      call("enqueueSubtitlesTranslateRequest", { ...plan(), hash: "wrong" }),
    ).rejects.toThrow("identity")
    mocks.get.mockResolvedValue({ translation: "cached" })
    const result = call("enqueueSubtitlesTranslateRequest", plan())
    await vi.advanceTimersByTimeAsync(101)
    expect(await result).toBe("cached")
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

  it("caches the complete ordered batch, never reuses one cue with changed neighbours or boundaries", async () => {
    const cache = new Map<string, any>()
    mocks.get.mockImplementation(async (key) => cache.get(key))
    mocks.put.mockImplementation(async (entry) => cache.set(entry.key, entry))
    const make = (text: string) =>
      createSubtitleTranslationPlan({
        ...plan(),
        text,
        glossaryRevision: 4,
        glossaryTerms: [
          { matchKey: text, source: text, target: `term-${text}`, keepOriginal: false },
        ],
        promptConfig: DEFAULT_CONFIG.videoSubtitles,
      }).request
    const a = make("A"),
      b = make("B"),
      c = make("C")
    mocks.execute.mockImplementation(async (text, _lang, _provider, resolver, options) => {
      const prompt = await resolver("Chinese", text, options)
      for (const term of options.glossaryTerms) expect(prompt.systemPrompt).toContain(term.target)
      return text
        .split(`\n\n${BATCH_SEPARATOR}\n\n`)
        .map((cue: string) => `${cue} translated with ${text.replaceAll("\n", " ")}`)
        .join(`\n\n${BATCH_SEPARATOR}\n\n`)
    })
    const run = async (...requests: (typeof a)[]) => {
      const result = Promise.all(
        requests.map((request) => call("enqueueSubtitlesTranslateRequest", request)),
      )
      await vi.advanceTimersByTimeAsync(101)
      return result
    }
    const ab = await run(a, b)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(cache.has(a.hash)).toBe(false)
    expect(cache.has(b.hash)).toBe(false)
    expect(await run(a, b)).toEqual(ab)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect((await run(a, c))[0]).not.toBe(ab[0])
    expect((await run(a))[0]).not.toBe(ab[0])
    expect(await run(b, a)).not.toEqual([ab[1], ab[0]])
    expect(mocks.execute).toHaveBeenCalledTimes(4)
  })

  it("isolates fallback cache entries from the failed batch and preserves each cue's glossary", async () => {
    const cache = new Map<string, any>()
    mocks.get.mockImplementation(async (key) => cache.get(key))
    mocks.put.mockImplementation(async (entry) => cache.set(entry.key, entry))
    const a = plan()
    const b = createSubtitleTranslationPlan({
      ...a,
      text: "world",
      promptConfig: DEFAULT_CONFIG.videoSubtitles,
      glossaryTerms: [{ matchKey: "world", source: "world", target: "世界", keepOriginal: false }],
    }).request
    mocks.execute.mockImplementation(async (text, _lang, _provider, _resolver, options) => {
      if (text.includes(BATCH_SEPARATOR)) return "wrong count"
      expect(options.glossaryTerms).toEqual(text === "world" ? b.glossaryTerms : [])
      return `solo ${text}`
    })
    const result = Promise.all(
      [a, b].map((request) => call("enqueueSubtitlesTranslateRequest", request)),
    )
    await vi.advanceTimersByTimeAsync(8000)
    expect(await result).toEqual(["solo hello", "solo world"])
    expect(cache.has(a.hash)).toBe(false)
    expect(cache.has(b.hash)).toBe(false)
    expect([...cache.values()].some((entry) => entry.translation.includes("wrong count"))).toBe(
      false,
    )
    const calls = mocks.execute.mock.calls.length
    const single = call("enqueueSubtitlesTranslateRequest", a)
    await vi.advanceTimersByTimeAsync(101)
    expect(await single).toBe("solo hello")
    expect(mocks.execute).toHaveBeenCalledTimes(calls)
    mocks.execute.mockResolvedValue(`batch hello\n\n${BATCH_SEPARATOR}\n\nbatch world`)
    const batch = Promise.all(
      [a, b].map((request) => call("enqueueSubtitlesTranslateRequest", request)),
    )
    await vi.advanceTimersByTimeAsync(101)
    expect(await batch).toEqual(["batch hello", "batch world"])
    expect(mocks.execute).toHaveBeenCalledTimes(calls + 1)
  })

  it("ignores legacy per-cue cache entries and rejects malformed batch cache results", async () => {
    const a = plan()
    const b = createSubtitleTranslationPlan({
      ...a,
      text: "world",
      promptConfig: DEFAULT_CONFIG.videoSubtitles,
    }).request
    mocks.get.mockImplementation(async (key) => ({
      translation: key === a.hash || key === b.hash ? "poisoned old cue" : "invalid batch count",
    }))
    mocks.execute.mockResolvedValue(`new hello\n\n${BATCH_SEPARATOR}\n\nnew world`)
    const pending = Promise.all(
      [a, b].map((request) => call("enqueueSubtitlesTranslateRequest", request)),
    )
    await vi.advanceTimersByTimeAsync(101)
    expect(await pending).toEqual(["new hello", "new world"])
    expect(mocks.get).not.toHaveBeenCalledWith(a.hash)
    expect(mocks.get).not.toHaveBeenCalledWith(b.hash)
  })

  it("retains every live subscriber's scope when a deduplicated cue falls back", async () => {
    let finish!: (text: string) => void
    let signal: AbortSignal | undefined
    mocks.execute.mockImplementation(async (text, _lang, _provider, _resolver, options) => {
      if (text.includes(BATCH_SEPARATOR)) return "wrong count"
      if (text !== "hello") return "world"
      signal = options.signal
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    })
    const first = call("enqueueSubtitlesTranslateRequest", plan("playback")).catch((error) => error)
    const shared = call("enqueueSubtitlesTranslateRequest", plan("export"), 8)
    const other = call(
      "enqueueSubtitlesTranslateRequest",
      createSubtitleTranslationPlan({
        ...plan("other"),
        text: "world",
        promptConfig: DEFAULT_CONFIG.videoSubtitles,
      }).request,
    )
    await vi.advanceTimersByTimeAsync(7101)
    expect(signal?.aborted).toBe(false)
    await call("cancelSubtitleRequests", { sessionId: "playback" })
    expect(signal?.aborted).toBe(false)
    finish("shared translation")
    expect(await shared).toBe("shared translation")
    expect((await first).name).toBe("TranslationCancelledError")
    expect(await other).toBe("world")
  })

  it("does not deduplicate pending cues across glossary revisions", async () => {
    const separator = `\n\n${BATCH_SEPARATOR}\n\n`
    mocks.execute.mockImplementation(async (text) =>
      text
        .split(separator)
        .map((cue: string) => `${cue} with ${text.includes("B") ? "B" : "C"}`)
        .join(separator),
    )
    const a = plan()
    const first = call("enqueueSubtitlesTranslateRequest", { ...a, glossaryRevision: 1 })
    const b = call(
      "enqueueSubtitlesTranslateRequest",
      createSubtitleTranslationPlan({
        ...a,
        text: "B",
        glossaryRevision: 1,
        promptConfig: DEFAULT_CONFIG.videoSubtitles,
      }).request,
    )
    const second = call("enqueueSubtitlesTranslateRequest", { ...a, glossaryRevision: 2 })
    const c = call(
      "enqueueSubtitlesTranslateRequest",
      createSubtitleTranslationPlan({
        ...a,
        text: "C",
        glossaryRevision: 2,
        promptConfig: DEFAULT_CONFIG.videoSubtitles,
      }).request,
    )
    await vi.advanceTimersByTimeAsync(101)
    expect(await first).toBe("hello with B")
    expect(await second).toBe("hello with C")
    await Promise.all([b, c])
    expect(mocks.execute).toHaveBeenCalledTimes(2)
  })
})

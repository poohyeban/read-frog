import { writeFileSync } from "node:fs"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { browser, storage } from "#imports"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR } from "@/utils/constants/prompt"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { Sha256Hex, Sha256Fields } from "@/utils/hash"
import { LANG_CODE_TO_EN_NAME } from "@/utils/languages"
import { getSubtitlesTranslatePromptFromConfig } from "@/utils/prompts/subtitles"
import { attachRequestErrorMeta } from "@/utils/request/retry-policy"
import { unwrapSubtitleResult, subtitleFailure } from "@/utils/subtitles/result"
import { createSubtitleTranslationPlan } from "@/utils/subtitles/translation-plan"
import { chunkSubtitleWork } from "@/utils/subtitles/work-policy"
import { subtitleWorkRuntime, SubtitleWorkRuntime } from "../subtitle-work"
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
const leases = new Map<number, string>()
const call = async (type: string, data: any, tab = 7) => {
  const sender = { tab: { id: tab }, frameId: 0 }
  if (
    [
      "enqueueSubtitlesTranslateRequest",
      "enqueueSubtitlesTranslateBatch",
      "aiSegmentSubtitles",
      "getSubtitlesSummary",
    ].includes(type)
  ) {
    let lease = leases.get(tab)
    if (!lease) {
      lease = await mocks.handlers.get("openSubtitleLease")!({ data: {}, sender })
      leases.set(tab, lease!)
    }
    data = {
      ...data,
      work: { lease, lane: "fast", urgent: true, logicalKey: "test", start: 0, end: 1000 },
    }
  }
  return mocks.handlers.get(type)!({ data, sender })
}
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
    Object.assign(subtitleWorkRuntime, new SubtitleWorkRuntime())
    vi.useFakeTimers()
    vi.resetAllMocks()
    mocks.handlers.clear()
    leases.clear()
    mocks.config.mockResolvedValue(structuredClone(DEFAULT_CONFIG))
    mocks.get.mockResolvedValue(undefined)
    mocks.put.mockResolvedValue(undefined)
    storage.watch = vi.fn<(...args: any[]) => any>(() => () => {})
    browser.tabs.onRemoved.addListener = vi.fn<(...args: any[]) => any>()
    setupSubtitlesTranslationHandlers()
  })
  afterEach(() => vi.useRealTimers())
  it("keeps a legal five-cue planned batch in one Provider call", async () => {
    mocks.execute.mockImplementation(async (text) =>
      text
        .split(BATCH_SEPARATOR)
        .map((part: string) => `T:${part.trim()}`)
        .join(`\n${BATCH_SEPARATOR}\n`),
    )
    const requests = Array.from(
      { length: 5 },
      (_, i) =>
        createSubtitleTranslationPlan({
          ...plan(),
          text: `cue-${i}`,
          promptConfig: DEFAULT_CONFIG.videoSubtitles,
        }).request,
    )
    const pending = call("enqueueSubtitlesTranslateBatch", {
      ...requests[0],
      members: requests.map(({ text }) => ({ text })),
    })
    await vi.advanceTimersByTimeAsync(101)
    expect((await pending).results).toHaveLength(5)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })
  it.each([5, 10, 20, 32])(
    "executes %i legal short members atomically and caches the complete prompt",
    async (size) => {
      const cache = new Map<string, any>()
      mocks.get.mockImplementation(async (key) => cache.get(key))
      mocks.put.mockImplementation(async (row) => cache.set(row.key, row))
      mocks.execute.mockImplementation(async (text) =>
        text
          .split(BATCH_SEPARATOR)
          .map((part: string) => `T:${part.trim()}`)
          .join(`\n${BATCH_SEPARATOR}\n`),
      )
      const request = {
        ...plan(),
        members: Array.from({ length: size }, (_, i) => ({ text: `cue-${i}` })),
      }
      const first = await call("enqueueSubtitlesTranslateBatch", request)
      expect(first.results).toHaveLength(size)
      expect(first.results.every((r: any) => r.outcome.status === "success")).toBe(true)
      expect(mocks.execute).toHaveBeenCalledTimes(1)
      expect(mocks.execute.mock.calls[0]![0].split(BATCH_SEPARATOR)).toHaveLength(size)
      await call("enqueueSubtitlesTranslateBatch", { ...request, sessionId: "next-tab" }, 8)
      expect(mocks.execute).toHaveBeenCalledTimes(1)
      expect(first.results[0].batchKey).toBe(first.results[size - 1].batchKey)
    },
  )
  it("retains four successes while recovering only the invalid fifth member", async () => {
    mocks.execute.mockImplementation(async (text) => {
      const parts = text.split(BATCH_SEPARATOR)
      return parts
        .map((part: string, i: number) => (parts.length === 5 && i === 2 ? "" : `T:${part.trim()}`))
        .join(`\n${BATCH_SEPARATOR}\n`)
    })
    const result = await call("enqueueSubtitlesTranslateBatch", {
      ...plan(),
      members: Array.from({ length: 5 }, (_, i) => ({ text: `cue-${i}` })),
    })
    expect(result.results.every((r: any) => r.outcome.status === "success")).toBe(true)
    expect(mocks.execute.mock.calls.map((c) => c[0].split(BATCH_SEPARATOR).length)).toEqual([5, 1])
    expect(mocks.execute.mock.calls[1]![0]).toBe("cue-2")
  })
  it("shares concurrent complete batches across tabs and retains the surviving subscriber", async () => {
    let finish!: (value: string) => void
    let signal: AbortSignal | undefined
    mocks.execute.mockImplementation((_text, _lang, _provider, _resolver, options) => {
      signal = options.signal
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    })
    const request = { ...plan(), members: [{ text: "A" }, { text: "B" }] }
    const first = call("enqueueSubtitlesTranslateBatch", request)
    await vi.advanceTimersByTimeAsync(0)
    const second = call("enqueueSubtitlesTranslateBatch", { ...request, sessionId: "second" }, 8)
    await vi.advanceTimersByTimeAsync(0)
    await call("cancelSubtitleRequests", { sessionId: request.sessionId })
    expect(signal?.aborted).toBe(false)
    finish(`T:A\n${BATCH_SEPARATOR}\nT:B`)
    expect((await first).outcome.status).toBe("cancelled")
    expect((await second).results).toHaveLength(2)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })
  it("rejects illegal character and member bounds before dispatch", async () => {
    for (const members of [
      [{ text: "x".repeat(2401) }],
      Array.from({ length: 33 }, () => ({ text: "x" })),
    ]) {
      expect(
        (await call("enqueueSubtitlesTranslateBatch", { ...plan(), members })).outcome,
      ).toMatchObject({ status: "permanent", code: "input-limit" })
    }
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it("measures actual queue factory batching with deterministic mock transport latency", async () => {
    const rows: unknown[] = []
    subtitleWorkRuntime.setDiagnostics(true)
    for (const size of [5, 10, 20, 32])
      for (const chars of [16, 200])
        for (const latency of [5, 200])
          for (const mode of ["legacy", "planned"] as const) {
            const countersBefore = subtitleWorkRuntime.snapshot().counters
            const starts: {
              members: number
              promptCharacters: number
              estimatedInputTokens: number
            }[] = []
            mocks.execute.mockImplementation(async (text, _lang, _provider, resolver, options) => {
              const prompt = await resolver("Chinese", text, options)
              const rendered = prompt.systemPrompt + prompt.prompt
              starts.push({
                members: text.split(BATCH_SEPARATOR).length,
                promptCharacters: rendered.length,
                estimatedInputTokens: new TextEncoder().encode(rendered).length + 64,
              })
              await new Promise((resolve) => setTimeout(resolve, latency))
              return text
                .split(BATCH_SEPARATOR)
                .map((part: string) => `T:${part.trim()}`)
                .join(`\n${BATCH_SEPARATOR}\n`)
            })
            const source = Array.from({ length: size }, (_, i) => ({
              text: `${i}:`.padEnd(chars, "x"),
              start: i * 100,
              end: i * 100 + 90,
            }))
            const chunks = chunkSubtitleWork(source, size)
            const stamp = Date.now()
            const ready: number[] = []
            let ipc = 0,
              index = 0
            const pending = chunks.flatMap((chunk) => {
              if (mode === "legacy")
                return chunk.map((member) => {
                  const memberIndex = index++
                  ipc++
                  const request = createSubtitleTranslationPlan({
                    ...plan(`metrics-${stamp}`),
                    text: member.text,
                    promptConfig: DEFAULT_CONFIG.videoSubtitles,
                  }).request
                  return call("enqueueSubtitlesTranslateRequest", request).then(() => {
                    ready[memberIndex] = Date.now() - stamp
                  })
                })
              const offset = index
              index += chunk.length
              ipc++
              return [
                call("enqueueSubtitlesTranslateBatch", {
                  ...plan(`metrics-${stamp}`),
                  members: chunk.map(({ text }) => ({ text })),
                }).then((result) => {
                  expect(result.results).toHaveLength(chunk.length)
                  chunk.forEach((_, i) => {
                    ready[offset + i] = Date.now() - stamp
                  })
                }),
              ]
            })
            await vi.advanceTimersByTimeAsync(5000)
            await Promise.all(pending)
            rows.push({
              size,
              chars,
              latency,
              mode,
              ipc,
              providerStarts: starts.length,
              requests: starts,
              firstMs: ready[0],
              fifthMs: ready[4],
              flushes: Object.fromEntries(
                Object.entries(subtitleWorkRuntime.snapshot().counters)
                  .filter(([key]) => key.startsWith("flush:"))
                  .map(([key, value]) => [key, value - (countersBefore[key] ?? 0)]),
              ),
              cacheHits:
                (subtitleWorkRuntime.snapshot().counters["cache-hit"] ?? 0) -
                (countersBefore["cache-hit"] ?? 0),
              deduplicated:
                (subtitleWorkRuntime.snapshot().counters["deduplicated:subtitles"] ?? 0) -
                (countersBefore["deduplicated:subtitles"] ?? 0),
              actualUsage: null,
              actualHttpRequests: null,
              note: "Real queue factories, mocked executeTranslate transport; no paid API or HTTP measurement.",
            })
          }
    if (process.env.SUBTITLE_REVIEW_METRICS)
      writeFileSync(process.env.SUBTITLE_REVIEW_METRICS, JSON.stringify(rows, null, 2))
    expect(rows).toHaveLength(32)
  })
  it.each(["plain", "pipe|text"])(
    "only restores provably unambiguous legacy complete-prompt cache: %s",
    async (text) => {
      const request = createSubtitleTranslationPlan({
        ...plan(),
        text,
        promptConfig: DEFAULT_CONFIG.videoSubtitles,
      }).request
      const prompt = getSubtitlesTranslatePromptFromConfig(
        DEFAULT_CONFIG.videoSubtitles,
        LANG_CODE_TO_EN_NAME[request.langConfig.targetCode],
        text,
        { isBatch: true, context: {}, glossaryTerms: [] },
      )
      const fields = [
        "subtitle-batch-prompt-v1",
        JSON.stringify(request.providerRef.config),
        request.langConfig.sourceCode,
        request.langConfig.targetCode,
        JSON.stringify([text]),
        prompt.systemPrompt,
        prompt.prompt,
      ]
      const oldKey = Sha256Hex(...fields),
        newKey = Sha256Fields(...fields)
      mocks.get.mockImplementation(async (key) =>
        key === oldKey
          ? {
              key: oldKey,
              translation: "legacy translation",
              subtitleInputs: [text],
              createdAt: new Date(),
            }
          : undefined,
      )
      mocks.execute.mockResolvedValue("fresh translation")
      const result = await call("enqueueSubtitlesTranslateBatch", {
        ...request,
        members: [{ text }],
      })
      expect(result.results[0].batchKey).toBe(newKey)
      const safe = text === "plain"
      const expectedTranslation = safe ? "legacy translation" : "fresh translation"
      expect(result.results[0].translation).toBe(expectedTranslation)
      expect(mocks.execute).toHaveBeenCalledTimes(safe ? 0 : 1)
      expect(mocks.put).toHaveBeenCalledWith(
        expect.objectContaining({ key: newKey, translation: expectedTranslation }),
      )
      expect(mocks.get.mock.calls.some((entry) => entry[0] === oldKey)).toBe(safe)
    },
  )
  it("never shares a complete batch cache across credentials", async () => {
    const cache = new Map<string, any>()
    mocks.get.mockImplementation(async (key) => cache.get(key))
    mocks.put.mockImplementation(async (row) => cache.set(row.key, row))
    mocks.execute.mockResolvedValue("translated")
    const request = { ...plan(), members: [{ text: "same source" }] }
    await call("enqueueSubtitlesTranslateBatch", request)
    await call("enqueueSubtitlesTranslateBatch", {
      ...request,
      providerRef: {
        ...request.providerRef,
        config: { ...request.providerRef.config, apiKey: "another-mock-account" },
      },
    })
    expect(mocks.execute).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(2)
  })
  it("starts zero Provider requests after root lease revocation acknowledgement", async () => {
    const pending = call("enqueueSubtitlesTranslateRequest", plan("pending")).catch(
      (error) => error,
    )
    await vi.advanceTimersByTimeAsync(0)
    await call("revokeSubtitleLease", { lease: leases.get(7) })
    await vi.advanceTimersByTimeAsync(60000)
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(await pending).toMatchObject({ name: "TranslationCancelledError" })
    for (let i = 0; i < 100; i++)
      await call("enqueueSubtitlesTranslateRequest", plan(`after-${i}`)).catch(() => {})
    await vi.advanceTimersByTimeAsync(60000)
    expect(mocks.execute).not.toHaveBeenCalled()
  })
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
      expect.objectContaining({ maxOutputTokens: expect.any(Number) }),
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

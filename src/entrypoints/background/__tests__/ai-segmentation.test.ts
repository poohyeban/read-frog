import { beforeEach, describe, expect, it, vi } from "vitest"
import { Sha256Fields, safeLegacyFieldsHash } from "@/utils/hash"
import { getSubtitlesSegmentationPrompt } from "@/utils/prompts/subtitles-segmentation"
import { getProviderCacheIdentity } from "@/utils/providers/provider-ref"

const generateTextForProviderRefMock = vi.fn<(...args: any[]) => any>()
const cacheGetMock = vi.fn<(...args: any[]) => any>()
const cachePutMock = vi.fn<(...args: any[]) => any>()
const cacheDeleteMock = vi.fn<(...args: any[]) => any>()

vi.mock("../background-stream", () => ({
  generateTextForProviderRef: generateTextForProviderRefMock,
}))

vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    aiSegmentationCache: {
      get: cacheGetMock,
      put: cachePutMock,
      delete: cacheDeleteMock,
    },
  },
}))

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn<(...args: any[]) => any>(),
    error: vi.fn<(...args: any[]) => any>(),
  },
}))

// The trust-boundary guard is real here, so the fixture must name a provider
// that actually has a model to prompt.
const providerRef = {
  kind: "local" as const,
  config: { id: "openai-default", provider: "openai" } as never,
}
const jsonContent = JSON.stringify([{ s: 1000, e: 2000, t: "hello world" }])

const parseableVtt = "WEBVTT\n\n1000 --> 2000\nHello world."
// A refusal/garbage answer: cleaning prepends WEBVTT but it still has no cues.
const unparseableAnswer = "Sorry, I cannot segment this."

describe("runAiSegmentSubtitles result validation", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    cacheGetMock.mockResolvedValue(undefined)
  })

  it("caches and returns a fresh result that parses to cues", async () => {
    generateTextForProviderRefMock.mockResolvedValue(`\`\`\`vtt\n${parseableVtt}\n\`\`\``)

    const { runAiSegmentSubtitles } = await import("../ai-segmentation")
    const result = await runAiSegmentSubtitles({ jsonContent, providerRef })

    expect(result).toBe(parseableVtt)
    expect(cachePutMock).toHaveBeenCalledWith(expect.objectContaining({ result: parseableVtt }))
  })

  it("throws without caching when the result yields no cues", async () => {
    generateTextForProviderRefMock.mockResolvedValue(unparseableAnswer)

    const { runAiSegmentSubtitles } = await import("../ai-segmentation")

    await expect(runAiSegmentSubtitles({ jsonContent, providerRef })).rejects.toThrow(
      /source timeline|unparseable/,
    )
    expect(cachePutMock).not.toHaveBeenCalled()
  })

  it("returns a parseable cached result without regenerating", async () => {
    cacheGetMock.mockResolvedValue({ result: parseableVtt })

    const { runAiSegmentSubtitles } = await import("../ai-segmentation")
    const result = await runAiSegmentSubtitles({ jsonContent, providerRef })

    expect(result).toBe(parseableVtt)
    expect(generateTextForProviderRefMock).not.toHaveBeenCalled()
    expect(cacheDeleteMock).not.toHaveBeenCalled()
  })

  it("drops an unparseable cached entry and regenerates", async () => {
    // An entry poisoned before results were parse-checked must not be served
    // forever; it is deleted and the chunk regenerated.
    cacheGetMock.mockResolvedValue({ result: `WEBVTT\n\n${unparseableAnswer}` })
    generateTextForProviderRefMock.mockResolvedValue(parseableVtt)

    const { runAiSegmentSubtitles } = await import("../ai-segmentation")
    const result = await runAiSegmentSubtitles({ jsonContent, providerRef })

    expect(cacheDeleteMock).toHaveBeenCalledTimes(1)
    expect(generateTextForProviderRefMock).toHaveBeenCalledTimes(1)
    expect(result).toBe(parseableVtt)
    expect(cachePutMock).toHaveBeenCalledWith(expect.objectContaining({ result: parseableVtt }))
  })
  it("rejects a parseable shifted result without poisoning the cache", async () => {
    generateTextForProviderRefMock.mockResolvedValue("WEBVTT\n\n0 --> 1000\nHello world.")
    const { runAiSegmentSubtitles } = await import("../ai-segmentation")
    await expect(runAiSegmentSubtitles({ jsonContent, providerRef })).rejects.toThrow(
      /source timeline/,
    )
    expect(cachePutMock).not.toHaveBeenCalled()
  })

  it("evicts a parseable but misaligned old cache entry", async () => {
    cacheGetMock.mockResolvedValue({ result: "WEBVTT\n\n0 --> 1000\nHello world." })
    generateTextForProviderRefMock.mockResolvedValue(parseableVtt)
    const { runAiSegmentSubtitles } = await import("../ai-segmentation")
    await expect(runAiSegmentSubtitles({ jsonContent, providerRef })).resolves.toBe(parseableVtt)
    expect(cacheDeleteMock).toHaveBeenCalledTimes(1)
    expect(generateTextForProviderRefMock).toHaveBeenCalledTimes(1)
  })
})

it("evicts only the misaligned legacy hit, preserving a concurrently filled new key and unrelated rows", async () => {
  vi.resetAllMocks()
  const { systemPrompt, prompt } = getSubtitlesSegmentationPrompt(jsonContent)
  const fields = [
    "subtitle-segmentation-v5:bounded:indexed",
    systemPrompt,
    prompt,
    getProviderCacheIdentity(providerRef),
  ]
  const cacheKey = Sha256Fields(...fields),
    legacyKey = safeLegacyFieldsHash(...fields)!
  expect(legacyKey).toBeDefined()
  const invalid = {
    key: legacyKey,
    result: "WEBVTT\n\n0 --> 1000\nHello world.",
    createdAt: new Date(),
  }
  const valid = { key: cacheKey, result: parseableVtt, createdAt: new Date() }
  const unrelated = { key: "unrelated", result: parseableVtt, createdAt: new Date() }
  const rows = new Map([
    [legacyKey, invalid],
    [unrelated.key, unrelated],
  ])
  cacheGetMock.mockImplementation(async (key) => {
    const row = rows.get(key)
    // Another request fills the new identity after this reader missed it.
    if (key === legacyKey) rows.set(cacheKey, valid)
    return row
  })
  cacheDeleteMock.mockImplementation(async (key) => rows.delete(key))
  const { getCachedAiSegmentation } = await import("../ai-segmentation")
  expect(await getCachedAiSegmentation({ jsonContent, providerRef })).toBeNull()
  expect(cacheDeleteMock).toHaveBeenCalledExactlyOnceWith(legacyKey)
  expect(rows.has(legacyKey)).toBe(false)
  expect(rows.get(cacheKey)).toBe(valid)
  expect(rows.get(unrelated.key)).toBe(unrelated)
  expect(await getCachedAiSegmentation({ jsonContent, providerRef })).toBe(parseableVtt)
  expect(cacheGetMock.mock.calls.filter(([key]) => key === legacyKey)).toHaveLength(1)
})

it("promotes an aligned safe legacy hit to the new identity without deleting it or generating", async () => {
  vi.resetAllMocks()
  const { systemPrompt, prompt } = getSubtitlesSegmentationPrompt(jsonContent)
  const fields = [
    "subtitle-segmentation-v5:bounded:indexed",
    systemPrompt,
    prompt,
    getProviderCacheIdentity(providerRef),
  ]
  const cacheKey = Sha256Fields(...fields),
    legacyKey = safeLegacyFieldsHash(...fields)!
  const row = { key: legacyKey, result: parseableVtt, createdAt: new Date(1) }
  cacheGetMock.mockImplementation(async (key) => (key === legacyKey ? row : undefined))
  const { getCachedAiSegmentation } = await import("../ai-segmentation")
  expect(await getCachedAiSegmentation({ jsonContent, providerRef })).toBe(parseableVtt)
  expect(cachePutMock).toHaveBeenCalledExactlyOnceWith({ ...row, key: cacheKey })
  expect(cacheDeleteMock).not.toHaveBeenCalled()
  expect(generateTextForProviderRefMock).not.toHaveBeenCalled()
})

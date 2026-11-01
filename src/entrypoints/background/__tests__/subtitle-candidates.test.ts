import type { SubtitleCandidateBundle, SubtitlesFragment } from "@/utils/subtitles/types"
import { beforeEach, expect, it, vi } from "vitest"
const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (message: any) => Promise<any>>(),
  bundles: [] as SubtitleCandidateBundle[],
  batches: new Map<string, any>(),
  revision: 0,
  live: true,
}))
import { storage } from "#imports"
import { GLOSSARY_REVISION_KEY } from "@/utils/constants/glossary"
vi.mock("@/utils/message", () => ({
  onMessage: (name: string, handler: any) => fixture.handlers.set(name, handler),
}))
vi.mock("../subtitle-work", () => ({
  subtitleWorkRuntime: { hasLease: () => fixture.live, note: () => {} },
}))
vi.mock("../translation-queues", () => ({ parseBatchResult: (text: string) => text.split("|") }))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    translationCache: {
      bulkGet: async (keys: string[]) => keys.map((k) => fixture.batches.get(k)),
    },
    subtitleCandidates: {
      put: async (row: SubtitleCandidateBundle) => {
        fixture.bundles.push(row)
      },
      where: () => ({
        below: (key: string | Date) => ({
          delete: async () => {},
          limit: () => ({
            count: async () =>
              Number(fixture.bundles.some((b) => typeof key === "string" && b.trackKey < key)),
          }),
        }),
        above: (key: string) => ({
          limit: () => ({
            count: async () => Number(fixture.bundles.some((b) => b.trackKey > key)),
          }),
        }),
        between: ([key, start]: [string, number], [, end]: [string, number]) => ({
          filter: (predicate: (b: SubtitleCandidateBundle) => boolean) => ({
            limit: () => ({
              toArray: async () =>
                fixture.bundles.filter(
                  (b) => b.trackKey === key && b.start >= start && b.start < end && predicate(b),
                ),
            }),
          }),
        }),
      }),
    },
  },
}))
import { setupSubtitleCandidateHandlers } from "../subtitle-candidates"
const cues: SubtitlesFragment[] = [
  {
    start: 0,
    end: 2000,
    text: "first",
    translation: "一",
    translationBatchKey: "whole-prompt",
    translationBatchIndex: 0,
    glossaryRevision: 0,
  },
]
beforeEach(async () => {
  fixture.handlers.clear()
  fixture.bundles = []
  fixture.batches.clear()
  fixture.revision = 0
  await storage.setItem(GLOSSARY_REVISION_KEY, 0)
  fixture.live = true
  fixture.batches.set("whole-prompt", {
    key: "whole-prompt",
    subtitleInputs: ["first", "second"],
    translation: "一|二",
  })
  setupSubtitleCandidateHandlers()
})
const save = () =>
  fixture.handlers.get("saveSubtitleCandidates")!({
    sender: { tab: { id: 1 } },
    data: { trackKey: "track", lane: "quality", lease: "lease", cues },
  })
const read = () =>
  fixture.handlers.get("getSubtitleCandidates")!({
    data: { trackKey: "track", start: 0, end: 60000 },
  })

it("restores a Quality selection only while its complete ordered batch remains valid", async () => {
  await save()
  expect(await read()).toHaveLength(1)
  fixture.batches.set("whole-prompt", {
    key: "whole-prompt",
    subtitleInputs: ["first", "second"],
    translation: "一",
  })
  expect(await read()).toEqual([])
})
it("does not restore stale glossary revisions or a cancelled session's publication", async () => {
  fixture.live = false
  await save()
  expect(await read()).toEqual([])
  fixture.live = true
  await save()
  fixture.revision++
  await storage.setItem(GLOSSARY_REVISION_KEY, fixture.revision)
  expect(await read()).toEqual([])
})

it("restores a valid position from a partial aligned batch but never its empty position", async () => {
  fixture.batches.set("whole-prompt", {
    key: "whole-prompt",
    subtitleInputs: ["first", "second"],
    translation: "一|",
  })
  await save()
  expect(await read()).toHaveLength(1)
  fixture.bundles[0]!.cues = [
    {
      ...cues[0]!,
      text: "second",
      translation: "",
      translationBatchIndex: 1,
    },
  ]
  expect(await read()).toEqual([])
})

it.each(["0".repeat(64), "f".repeat(64)])(
  "probes other indexed identities (%s) without treating a partial current hit as historical completeness",
  async (oldTrack) => {
    const probe = () =>
      fixture.handlers.get("getSubtitleCandidateWindow")!({
        data: { trackKey: "track", start: 0, end: 60000 },
      })
    expect(await probe()).toEqual({ bundles: [], mayHaveLegacy: false })
    await save()
    expect(await probe()).toMatchObject({ bundles: [expect.anything()], mayHaveLegacy: false })
    fixture.bundles.push({ ...fixture.bundles[0]!, key: "old", trackKey: oldTrack })
    expect(await probe()).toMatchObject({ bundles: [expect.anything()], mayHaveLegacy: true })
    const combined = await fixture.handlers.get("getSubtitleCandidates")!({
      data: { trackKey: "track", legacyTrackKeys: [oldTrack], start: 0, end: 60000 },
    })
    expect(combined.map((b: SubtitleCandidateBundle) => b.key)).toContain("old")
    expect(combined).toHaveLength(2)
  },
)
it("does not mistake another versioned new video for a historical track", async () => {
  await save()
  fixture.bundles.push({
    ...fixture.bundles[0]!,
    key: "other",
    trackKey: "subtitle-track-v3:" + "a".repeat(64),
  })
  const probe = await fixture.handlers.get("getSubtitleCandidateWindow")!({
    data: { trackKey: "track", start: 0, end: 60000 },
  })
  expect(probe.mayHaveLegacy).toBe(false)
})

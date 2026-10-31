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
        below: () => ({ delete: async () => {} }),
        equals: (key: string) => ({
          filter: (predicate: (b: SubtitleCandidateBundle) => boolean) => ({
            limit: () => ({
              toArray: async () =>
                fixture.bundles.filter((b) => b.trackKey === key && predicate(b)),
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

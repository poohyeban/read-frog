import type { SubtitleCandidateBundle, SubtitlesFragment } from "@/utils/subtitles/types"
import { storage } from "#imports"
import { GLOSSARY_REVISION_KEY } from "@/utils/constants/glossary"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { prepareTranslationText } from "@/utils/host/translate/text-preparation"
import { onMessage } from "@/utils/message"
import { assertSubtitleWindow } from "@/utils/subtitles/work-policy"
import { subtitleWorkRuntime } from "./subtitle-work"
import { parseBatchResult } from "./translation-queues"

/** Saved selections reference a validated whole-prompt cache, never a per-cue LLM cache. */
async function candidateValidator(cues: SubtitlesFragment[], revision: number) {
  const keys = [
    ...new Set(cues.flatMap((c) => (c.translationBatchKey ? [c.translationBatchKey] : []))),
  ]
  const rows = await db.translationCache.bulkGet(keys)
  const caches = new Map(
    rows.flatMap((row) => {
      if (!row?.subtitleInputs) return []
      try {
        const translated = parseBatchResult(row.translation)
        return translated.length === row.subtitleInputs.length
          ? [[row.key, { inputs: row.subtitleInputs, translated }] as const]
          : []
      } catch {
        return []
      }
    }),
  )
  return (candidates: SubtitlesFragment[]) =>
    candidates.length > 0 &&
    candidates.every((cue) => {
      const row = cue.translationBatchKey ? caches.get(cue.translationBatchKey) : undefined
      const index = cue.translationBatchIndex
      return (
        row &&
        index !== undefined &&
        Number.isInteger(index) &&
        index >= 0 &&
        cue.glossaryRevision === revision &&
        row.inputs[index] === prepareTranslationText(cue.text) &&
        row.translated[index] === cue.translation &&
        !!cue.translation?.trim()
      )
    })
}

let nextPrune = 0
export function setupSubtitleCandidateHandlers() {
  onMessage("getSubtitleCandidates", async ({ data }) => {
    if (
      !Number.isFinite(data.start) ||
      !Number.isFinite(data.end) ||
      data.end <= data.start ||
      data.end - data.start > 300_000
    )
      return []
    const revision = (await storage.getItem<number>(GLOSSARY_REVISION_KEY)) ?? 0
    const keys = [
      ...new Set([data.trackKey, ...(data.legacyTrackKey ? [data.legacyTrackKey] : [])]),
    ]
    const bundles = (
      await Promise.all(
        keys.map((trackKey) =>
          db.subtitleCandidates
            .where("[trackKey+start]")
            .between(
              [trackKey, Math.max(0, data.start - 60_000)],
              [trackKey, data.end],
              true,
              false,
            )
            .filter((bundle) => bundle.end > data.start)
            .limit(256)
            .toArray(),
        ),
      )
    ).flat()
    const validate = await candidateValidator(
      bundles.flatMap((bundle) => bundle.cues),
      revision,
    )
    const valid: SubtitleCandidateBundle[] = bundles.filter((bundle) => validate(bundle.cues))
    if (valid.length) subtitleWorkRuntime.note("candidate-cache-hit", undefined, valid.length)
    return valid
  })
  onMessage("saveSubtitleCandidates", async ({ data, sender }) => {
    if (!subtitleWorkRuntime.hasLease(sender.tab?.id, data.lease)) return
    assertSubtitleWindow(data.cues)
    const revision = (await storage.getItem<number>(GLOSSARY_REVISION_KEY)) ?? 0
    if (
      !(await candidateValidator(data.cues, revision))(data.cues) ||
      !subtitleWorkRuntime.hasLease(sender.tab?.id, data.lease)
    )
      return
    if (Date.now() >= nextPrune) {
      nextPrune = Date.now() + 60_000
      await db.subtitleCandidates
        .where("createdAt")
        .below(new Date(Date.now() - 7 * 24 * 60 * 60_000))
        .delete()
    }
    if (!subtitleWorkRuntime.hasLease(sender.tab?.id, data.lease)) return
    await db.subtitleCandidates.put({
      key: Sha256Hex(
        data.trackKey,
        data.lane,
        JSON.stringify(data.cues.map((c) => [c.translationBatchKey, c.translationBatchIndex])),
      ),
      trackKey: data.trackKey,
      lane: data.lane,
      cues: data.cues,
      start: Math.min(...data.cues.map((c) => c.start)),
      end: Math.max(...data.cues.map((c) => c.end)),
      createdAt: new Date(),
    })
  })
}

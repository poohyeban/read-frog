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
async function validCandidates(cues: SubtitlesFragment[], revision: number) {
  const keys = [
    ...new Set(cues.map((c) => c.translationBatchKey).filter((key): key is string => !!key)),
  ]
  const rows = await db.translationCache.bulkGet(keys)
  const caches = new Map(rows.flatMap((row) => (row ? [[row.key, row] as const] : [])))
  return (
    cues.length > 0 &&
    cues.every((cue) => {
      const row = cue.translationBatchKey ? caches.get(cue.translationBatchKey) : undefined
      if (
        !row?.subtitleInputs ||
        cue.translationBatchIndex === undefined ||
        cue.glossaryRevision !== revision
      )
        return false
      const translated = parseBatchResult(row.translation)
      return (
        translated.length === row.subtitleInputs.length &&
        row.subtitleInputs[cue.translationBatchIndex] === prepareTranslationText(cue.text) &&
        translated[cue.translationBatchIndex] === cue.translation &&
        !!cue.translation?.trim()
      )
    })
  )
}

export function setupSubtitleCandidateHandlers() {
  onMessage("getSubtitleCandidates", async ({ data }) => {
    if (
      !Number.isFinite(data.start) ||
      !Number.isFinite(data.end) ||
      data.end - data.start > 300_000
    )
      return []
    const revision = (await storage.getItem<number>(GLOSSARY_REVISION_KEY)) ?? 0
    const bundles = await db.subtitleCandidates
      .where("trackKey")
      .equals(data.trackKey)
      .filter((bundle) => bundle.end > data.start && bundle.start < data.end)
      .limit(256)
      .toArray()
    const valid: SubtitleCandidateBundle[] = []
    for (const bundle of bundles) {
      if (await validCandidates(bundle.cues, revision)) valid.push(bundle)
    }
    if (valid.length) subtitleWorkRuntime.note("candidate-cache-hit", undefined, valid.length)
    return valid
  })
  onMessage("saveSubtitleCandidates", async ({ data, sender }) => {
    if (!subtitleWorkRuntime.hasLease(sender.tab?.id, data.lease)) return
    assertSubtitleWindow(data.cues)
    const revision = (await storage.getItem<number>(GLOSSARY_REVISION_KEY)) ?? 0
    if (
      !(await validCandidates(data.cues, revision)) ||
      !subtitleWorkRuntime.hasLease(sender.tab?.id, data.lease)
    )
      return
    await db.subtitleCandidates
      .where("createdAt")
      .below(new Date(Date.now() - 7 * 24 * 60 * 60_000))
      .delete()
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

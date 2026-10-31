import type { SubtitlesFragment } from "./types"
import { cueIdentity, getCueTimeline } from "./cue-timeline"
import { isSegmentationAligned } from "./processor/ai-segmentation"

export interface TranscriptLine {
  id?: string
  anchorKey?: string
  sourceLanguage?: string
  start: number
  end: number
  text: string
  translation?: string
}

const previousLines = new WeakMap<SubtitlesFragment[], Map<string, TranscriptLine>>()
const sourcePositions = new WeakMap<SubtitlesFragment[], Map<string, number>>()

/** Result-driven projection. Whole Quality pairs own their source interval; a crossing
 * Fast row falls back to uncovered raw cues instead of duplicating or mixing text. */
export function buildTranscript(
  source: SubtitlesFragment[],
  translated: SubtitlesFragment[],
  raw: SubtitlesFragment[] = source,
): TranscriptLine[] {
  const timeline = getCueTimeline(raw)
  const rawCues = timeline.cues
  let positions = sourcePositions.get(raw)
  if (!positions) {
    positions = new Map(rawCues.map((cue, index) => [cueIdentity(cue), index]))
    sourcePositions.set(raw, positions)
  }
  const occupied = new Uint8Array(rawCues.length)
  const selections = new Map<number, { cue: SubtitlesFragment; end: number }>()
  const valid = (cue: SubtitlesFragment) =>
    !!cue.translation?.trim() &&
    (!cue.translationOutcome || cue.translationOutcome.status === "success")
  const fast = new Map(
    translated.filter((c) => c.lane !== "quality" && valid(c)).map((c) => [cueIdentity(c), c]),
  )
  function select(cue: SubtitlesFragment, key = cueIdentity(cue)) {
    const exact = positions!.get(key)
    if (exact !== undefined) {
      if (!occupied[exact]) {
        occupied[exact] = 1
        selections.set(exact, { cue, end: exact + 1 })
      }
      return
    }
    const covered = timeline.window(cue.start, cue.end)
    if (!isSegmentationAligned([...covered], [cue])) return
    const start = positions!.get(cueIdentity(covered[0]!))!
    const end = positions!.get(cueIdentity(covered.at(-1)!))! + 1
    for (let i = start; i < end; i++) if (occupied[i]) return
    occupied.fill(1, start, end)
    selections.set(start, { cue, end })
  }
  for (const cue of getCueTimeline(translated.filter((c) => c.lane === "quality" && valid(c))).cues)
    select(cue)
  for (const cue of getCueTimeline(source).cues) {
    const key = cueIdentity(cue)
    select(fast.get(key) ?? cue, key)
  }

  const previous = previousLines.get(source)
  const next = new Map<string, TranscriptLine>()
  const lines: TranscriptLine[] = []
  for (let i = 0; i < rawCues.length;) {
    const selected = selections.get(i)
    const cue = selected?.cue ?? rawCues[i]!
    const anchorKey = cueIdentity(rawCues[i]!)
    const translation = valid(cue) && cue.translation !== cue.text ? cue.translation : undefined
    const old = previous?.get(anchorKey)
    const line =
      old &&
      old.start === cue.start &&
      old.end === cue.end &&
      old.text === cue.text &&
      old.sourceLanguage === cue.sourceLanguage &&
      old.translation === translation
        ? old
        : {
            id: cue.id,
            anchorKey,
            sourceLanguage: cue.sourceLanguage,
            start: cue.start,
            end: cue.end,
            text: cue.text,
            translation,
          }
    lines.push(line)
    next.set(anchorKey, line)
    i = selected?.end ?? i + 1
  }
  previousLines.set(source, next)
  return lines
}

/**
 * Cues do not tile the timeline — a pause between them leaves a gap, and the
 * playhead sits before the first cue at the start. Returning -1 rather than
 * clamping keeps "nothing is being said" distinct from "the first line is".
 */
export function findActiveLine(lines: TranscriptLine[], timeMs: number): number {
  return getCueTimeline(lines).indexAt(timeMs)
}

export function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000)
  const seconds = String(total % 60).padStart(2, "0")
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`
}

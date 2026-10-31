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

interface Projection {
  raw: SubtitlesFragment[]
  translated: SubtitlesFragment[]
  lines: TranscriptLine[]
  byAnchor: Map<string, TranscriptLine>
}
interface SourceIndex {
  keys: string[]
  positions: Map<string, number>
  spans: WeakMap<SubtitlesFragment, { start: number; end: number } | null>
}
const projections = new WeakMap<SubtitlesFragment[], Projection>()
const sourceIndexes = new WeakMap<SubtitlesFragment[], SourceIndex>()
const identities = new WeakMap<SubtitlesFragment, string>()
function identity(cue: SubtitlesFragment) {
  let key = identities.get(cue)
  if (!key) {
    key = cueIdentity(cue)
    identities.set(cue, key)
  }
  return key
}

/** Immutable track publications drive projection; timeupdate never rebuilds rows.
 * Span validation and unchanged row objects survive incremental result publications. */
export function buildTranscript(
  source: SubtitlesFragment[],
  translated: SubtitlesFragment[],
  raw: SubtitlesFragment[] = source,
): TranscriptLine[] {
  const previous = projections.get(source)
  if (previous?.raw === raw && previous.translated === translated) return previous.lines
  const timeline = getCueTimeline(raw)
  const rawCues = timeline.cues
  let index = sourceIndexes.get(raw)
  if (!index) {
    const keys = rawCues.map(identity)
    index = { keys, positions: new Map(keys.map((key, i) => [key, i])), spans: new WeakMap() }
    sourceIndexes.set(raw, index)
  }
  const valid = (cue: SubtitlesFragment) =>
    !!cue.translation?.trim() &&
    (!cue.translationOutcome || cue.translationOutcome.status === "success")
  const fast = new Map<string, SubtitlesFragment>()
  const quality: SubtitlesFragment[] = []
  for (const cue of translated) {
    if (!valid(cue)) continue
    if (cue.lane === "quality") quality.push(cue)
    else fast.set(identity(cue), cue)
  }
  const direct = raw === source && !quality.length
  const occupied = direct ? null : new Uint8Array(rawCues.length)
  const selections = new Map<number, { cue: SubtitlesFragment; end: number }>()
  function span(cue: SubtitlesFragment) {
    const cached = index!.spans.get(cue)
    if (cached !== undefined) return cached
    const exact = index!.positions.get(identity(cue))
    let result: { start: number; end: number } | null = null
    if (exact !== undefined) result = { start: exact, end: exact + 1 }
    else {
      const covered = timeline.window(cue.start, cue.end)
      if (isSegmentationAligned(covered, [cue]))
        result = {
          start: index!.positions.get(identity(covered[0]!))!,
          end: index!.positions.get(identity(covered.at(-1)!))! + 1,
        }
    }
    index!.spans.set(cue, result)
    return result
  }
  function select(cue: SubtitlesFragment, range = span(cue)) {
    if (!range) return
    for (let i = range.start; i < range.end; i++) if (occupied![i]) return
    occupied!.fill(1, range.start, range.end)
    selections.set(range.start, { cue, end: range.end })
  }
  if (!direct) {
    for (const cue of quality.sort((a, b) => a.start - b.start)) select(cue)
    for (const cue of getCueTimeline(source).cues) select(fast.get(identity(cue)) ?? cue, span(cue))
  }
  const byAnchor = new Map<string, TranscriptLine>()
  const lines: TranscriptLine[] = []
  for (let i = 0; i < rawCues.length;) {
    const selected = selections.get(i)
    const anchorKey = index.keys[i]!
    const cue = direct ? (fast.get(anchorKey) ?? rawCues[i]!) : (selected?.cue ?? rawCues[i]!)
    const translation = valid(cue) && cue.translation !== cue.text ? cue.translation : undefined
    const old = previous?.byAnchor.get(anchorKey)
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
    byAnchor.set(anchorKey, line)
    i = selected?.end ?? i + 1
  }
  projections.set(source, { raw, translated, lines, byAnchor })
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

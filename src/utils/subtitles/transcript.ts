import type { SubtitlesFragment } from "./types"
import { cueIdentity, getCueTimeline } from "./cue-timeline"

export interface TranscriptLine {
  id?: string
  sourceLanguage?: string
  start: number
  end: number
  text: string
  translation?: string
}

const previousLines = new WeakMap<SubtitlesFragment[], Map<string, TranscriptLine>>()

/**
 * The source track is the skeleton: it exists whether or not translation is
 * running, and it is the one the player re-segments. Translations are matched
 * on complete cue identity; unchanged rows retain their references.
 */
export function buildTranscript(
  source: SubtitlesFragment[],
  translated: SubtitlesFragment[],
): TranscriptLine[] {
  const translationByIdentity = new Map(
    translated.filter((cue) => cue.translation).map((cue) => [cueIdentity(cue), cue.translation!]),
  )

  const previous = previousLines.get(source)
  const next = new Map<string, TranscriptLine>()
  const lines = getCueTimeline(source).cues.map((cue) => {
    const key = cueIdentity(cue)
    const translatedText = translationByIdentity.get(key)
    const translation = translatedText === cue.text ? undefined : translatedText
    const old = previous?.get(key)
    if (old && old.translation === translation) {
      next.set(key, old)
      return old
    }
    const line = {
      id: cue.id,
      sourceLanguage: cue.sourceLanguage,
      start: cue.start,
      end: cue.end,
      text: cue.text,
      // Passthrough and the error fallback copy the source into `translation`,
      // which would print the line twice.
      translation,
    }
    next.set(key, line)
    return line
  })
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

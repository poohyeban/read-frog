import type { SubtitlesFragment } from "./types"

export interface TranscriptLine {
  start: number
  end: number
  text: string
  translation?: string
}

/**
 * The source track is the skeleton: it exists whether or not translation is
 * running, and it is the one the player re-segments. Translations are matched
 * on `start`, which is already how the coordinator identifies a cue.
 */
export function buildTranscript(
  source: SubtitlesFragment[],
  translated: SubtitlesFragment[],
  previous: TranscriptLine[] = [],
): TranscriptLine[] {
  const translationByStart = new Map(
    translated.filter((cue) => cue.translation).map((cue) => [cue.start, cue.translation!]),
  )

  const lines = source.map((cue, index) => {
    const translation = translationByStart.get(cue.start)
    const normalized = translation === cue.text ? undefined : translation
    const old = previous[index]
    if (
      old &&
      old.start === cue.start &&
      old.end === cue.end &&
      old.text === cue.text &&
      old.translation === normalized
    )
      return old
    return { start: cue.start, end: cue.end, text: cue.text, translation: normalized }
  })
  return lines.length === previous.length && lines.every((line, index) => line === previous[index])
    ? previous
    : lines
}

/**
 * Cues do not tile the timeline — a pause between them leaves a gap, and the
 * playhead sits before the first cue at the start. Returning -1 rather than
 * clamping keeps "nothing is being said" distinct from "the first line is".
 */
export function findActiveLine(lines: TranscriptLine[], timeMs: number): number {
  return lines.findIndex((line) => line.start <= timeMs && line.end > timeMs)
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

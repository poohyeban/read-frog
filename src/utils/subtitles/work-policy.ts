import type { SubtitlesFragment } from "./types"
import { ResourceRejected } from "@/utils/request/resource-error"

/** Independent of playback speed, queue settings, and source track length. */
export const SUBTITLE_WORK_LIMITS = Object.freeze({
  cues: 32,
  sourceCharacters: 2400,
  promptCharacters: 12000,
  mediaMs: 60_000,
  outputTokens: 4096,
  queued: 64,
  batchMembers: 128,
})

export type SubtitleLane = "fast" | "quality" | "segmentation" | "context" | "export"
export interface SubtitleWorkContext {
  lease: string
  lane: SubtitleLane
  urgent: boolean
  logicalKey: string
  start: number
  end: number
}
export interface SubtitleModelUsage {
  inputTokens?: number
  outputTokens?: number
}
export interface SubtitleModelGuard {
  beforeCall: (input: string, outputTokens: number) => Promise<void>
  usage: (usage: SubtitleModelUsage) => Promise<void>
  onDispatch?: () => void
}

export class SubtitleWorkRejected extends ResourceRejected {}

/** UTF-8 bytes deliberately overestimate ordinary text tokenizers; not a currency guarantee. */
export function estimateInputTokens(input: string): number {
  return new TextEncoder().encode(input).length + 64
}

export function subtitleOutputLimit(input: string, segmentation = false): number {
  return Math.min(
    SUBTITLE_WORK_LIMITS.outputTokens,
    Math.max(128, Math.ceil(estimateInputTokens(input) * (segmentation ? 1.25 : 1.5))),
  )
}

export function assertSubtitleWindow(cues: readonly SubtitlesFragment[]) {
  if (
    !cues.length ||
    cues.length > SUBTITLE_WORK_LIMITS.cues ||
    cues.reduce((n, c) => n + c.text.length, 0) > SUBTITLE_WORK_LIMITS.sourceCharacters ||
    cues.some((c) => !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start) ||
    Math.max(...cues.map((c) => c.end)) - Math.min(...cues.map((c) => c.start)) >
      SUBTITLE_WORK_LIMITS.mediaMs
  )
    throw new SubtitleWorkRejected("input-limit")
}

/** Oversized individual cues are locally split, never granted a larger model allowance. */
export function boundedSourceCues(cues: readonly SubtitlesFragment[]): SubtitlesFragment[] {
  const bounded: SubtitlesFragment[] = []
  for (let sourceIndex = 0; sourceIndex < cues.length; sourceIndex++) {
    const cue = cues[sourceIndex]!
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) continue
    const pieces = Math.max(
      1,
      Math.ceil(cue.text.length / SUBTITLE_WORK_LIMITS.sourceCharacters),
      Math.ceil((cue.end - cue.start) / SUBTITLE_WORK_LIMITS.mediaMs),
    )
    if (pieces === 1) {
      if (cue.text.trim()) bounded.push(cue)
      continue
    }
    for (let part = 0; part < pieces; part++) {
      const text = cue.text.slice(
        Math.floor((cue.text.length * part) / pieces),
        Math.floor((cue.text.length * (part + 1)) / pieces),
      )
      if (text.trim())
        bounded.push({
          ...cue,
          id: `${cue.id ?? sourceIndex}:part:${part}`,
          text,
          start: cue.start + ((cue.end - cue.start) * part) / pieces,
          end: cue.start + ((cue.end - cue.start) * (part + 1)) / pieces,
        })
    }
  }
  return bounded
}

export function chunkSubtitleWork(
  cues: readonly SubtitlesFragment[],
  maxItems: number = SUBTITLE_WORK_LIMITS.cues,
): SubtitlesFragment[][] {
  const chunks: SubtitlesFragment[][] = []
  let current: SubtitlesFragment[] = [],
    characters = 0,
    end = 0
  for (const cue of boundedSourceCues(cues)) {
    if (
      current.length &&
      (current.length >= Math.min(maxItems, SUBTITLE_WORK_LIMITS.cues) ||
        characters + cue.text.length > SUBTITLE_WORK_LIMITS.sourceCharacters ||
        Math.max(end, cue.end) - current[0]!.start > SUBTITLE_WORK_LIMITS.mediaMs)
    ) {
      chunks.push(current)
      current = []
      characters = 0
      end = 0
    }
    current.push(cue)
    characters += cue.text.length
    end = Math.max(end, cue.end)
  }
  if (current.length) chunks.push(current)
  return chunks
}

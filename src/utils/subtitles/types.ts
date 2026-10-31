import type { SubtitleOutcome } from "./result"
export type SubtitlesState = "idle" | "loading" | "error"

export interface StateData {
  state: SubtitlesState
  message?: string
}

export interface SubtitlesFragment {
  id?: string
  sourceLanguage?: string
  text: string
  start: number
  end: number
  translation?: string
  translationOutcome?: SubtitleOutcome
  translationBatchKey?: string
  translationBatchIndex?: number
  glossaryRevision?: number
}

export interface SubtitleCandidateBundle {
  key: string
  trackKey: string
  lane: "fast" | "quality"
  cues: SubtitlesFragment[]
  start: number
  end: number
  createdAt: Date
}

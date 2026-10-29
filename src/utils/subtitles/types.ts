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
}

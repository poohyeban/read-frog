import type { SubtitlesFragment } from "@/utils/subtitles/types"

export interface SpeechInput {
  text: string
  voice: string
  speed?: number
  signal?: AbortSignal
}
export interface SpeechAudio {
  audioBase64: string
  contentType: string
}
export interface SpeechProvider {
  synthesize(input: SpeechInput): Promise<SpeechAudio>
}
export interface TranscriptionInput {
  audio: Blob
  format: "audio/wav" | "audio/mpeg" | "audio/mp4" | "audio/webm" | "audio/ogg" | "audio/flac"
  language?: string
  signal?: AbortSignal
}
export interface TranscriptionResult {
  text: string
  sourceLanguage?: string
  // The original subtitle engine uses milliseconds. No fabricated timing for text-only responses.
  segments: SubtitlesFragment[]
}
export interface TranscriptionProvider {
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>
}
export type AudioServiceErrorCode =
  | "NOT_CONFIGURED"
  | "INVALID_INPUT"
  | "INVALID_RESPONSE"
  | "HTTP"
  | "NETWORK"
  | "CANCELLED"
  | "TIMEOUT"
export class AudioServiceError extends Error {
  constructor(
    public readonly code: AudioServiceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "AudioServiceError"
  }
}

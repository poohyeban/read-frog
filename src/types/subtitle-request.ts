import type { Config } from "./config/config"
import type { MatchedTerm } from "@/utils/glossary/types"
import type { SerializableProviderRef } from "@/utils/providers/provider-ref"

export interface SubtitleRequestPayload {
  work?: import("@/utils/subtitles/work-policy").SubtitleWorkContext
  text: string
  langConfig: Config["language"]
  providerRef: SerializableProviderRef
  scheduleAt: number
  hash: string
  webTitle?: string | null
  webDescription?: string | null
  summary?: string | null
  glossaryTerms?: MatchedTerm[]
  glossaryRevision?: number
  promptConfig?: Pick<Config["videoSubtitles"], "customPromptsConfig">
  sessionId?: string
  priority?: number
  resultFormat?: "outcome"
}

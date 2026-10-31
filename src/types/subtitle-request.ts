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

/** Common snapshot is serialized once. Background owns all prompt planning. */
export type SubtitleBatchRequestPayload = Omit<
  SubtitleRequestPayload,
  "text" | "hash" | "glossaryTerms"
> & {
  members: { text: string; glossaryTerms?: MatchedTerm[] }[]
}

import type { Config } from "@/types/config/config"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { ProviderRequestRouting } from "@/types/provider-request"
import type { MatchedTerm } from "@/utils/glossary/types"

/** Shared transport contract; neither the planner nor Provider depends on a UI adapter. */
export type TranslationRequestPayload = ProviderRequestRouting & {
  glossaryTerms?: MatchedTerm[]
  glossaryRevision?: number
  text: string
  langConfig: Config["language"]
  scheduleAt: number
  hash: string
  textFormat?: TranslationTextFormat
  // Source line breaks are semantic (newline-preserving container or typed
  // input); providers whose transport collapses "\n" must protect them.
  preserveLineBreaks?: boolean
  webTitle?: string | null
  webDescription?: string | null
  webContent?: string | null
  webSummary?: string | null
  // Page-translation session this request belongs to; scopes the request
  // for cancelPageTranslationRequests. Absent for non-page requests
  // (old input/selection clients). New independent tasks carry their own scope.
  sessionId?: string
  promptConfig?: Pick<Config["pageTranslation"], "customPromptsConfig">
  forceRetranslation?: boolean
  planIdentity?: { version: 1; contextAware: boolean; extraHashTags: string[] }

  // scoped elsewhere does not — the background serves every tab and cannot
  // tell them apart. Passing `[]` means "nothing matched"

  // requests resolved either side of an edit made while the page was still
  // translating; without this the background would settle a disagreement by
  // message arrival order
}

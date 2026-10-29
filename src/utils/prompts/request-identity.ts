import type { TranslatePromptResult } from "./translate"
import type { Config } from "@/types/config/config"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { MatchedTerm } from "@/utils/glossary/types"
import type { SerializableProviderRef } from "@/utils/providers/provider-ref"
import { Sha256Hex } from "@/utils/hash"

/** Extension-internal only. Contains the selected template, never all preferences. */
export interface TranslationSnapshot {
  version: 2
  kind: "page" | "subtitles"
  template: TranslatePromptResult
  glossaryEnabled: boolean
  contentAware: boolean
  cacheTags?: string[]
}

export interface TranslationIdentityInput {
  text: string
  langConfig: Config["language"]
  providerRef: SerializableProviderRef
  snapshot?: TranslationSnapshot
  glossaryTerms?: readonly MatchedTerm[]
  textFormat?: TranslationTextFormat
  preserveLineBreaks?: boolean
  webTitle?: string | null
  webDescription?: string | null
  webContent?: string | null
  webSummary?: string | null
  summary?: string | null
}

/** Object property order is not semantic; array order (including terms) is. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    }
    return item
  })
}

export function getTranslationRequestHash(data: TranslationIdentityInput): string {
  return `translation:v2:${Sha256Hex(
    canonical({
      text: data.text,
      language: data.langConfig,
      provider: data.providerRef,
      snapshot: data.snapshot,
      terms: data.glossaryTerms ?? [],
      format: data.textFormat ?? "plain",
      preserveLineBreaks: data.preserveLineBreaks ?? false,
      context: [
        data.webTitle ?? null,
        data.webDescription ?? null,
        data.webContent ?? null,
        data.webSummary ?? data.summary ?? null,
      ],
    }),
  )}`
}

/** Validate BEFORE cache access. Older tabs must reload rather than poison v2. */
export function assertTranslationRequestIdentity(
  data: TranslationIdentityInput & { hash: string },
  kind: TranslationSnapshot["kind"],
): asserts data is TranslationIdentityInput & { hash: string; snapshot: TranslationSnapshot } {
  const snapshot = data.snapshot
  if (
    snapshot?.version !== 2 ||
    snapshot.kind !== kind ||
    typeof snapshot.template?.systemPrompt !== "string" ||
    typeof snapshot.template?.prompt !== "string" ||
    typeof snapshot.glossaryEnabled !== "boolean" ||
    typeof snapshot.contentAware !== "boolean" ||
    !Array.isArray(data.glossaryTerms) ||
    (!snapshot.glossaryEnabled && data.glossaryTerms.length > 0) ||
    data.hash !== getTranslationRequestHash(data)
  ) {
    throw new Error("Translation request is stale or inconsistent. Reload the page and retry.")
  }
}

export function getTranslationBatchIdentity(data: {
  provider: unknown
  langConfig: Config["language"]
  snapshot?: TranslationSnapshot
  context?: unknown
  glossaryRevision?: number
}): string {
  return Sha256Hex(
    canonical({
      provider: data.provider,
      language: data.langConfig,
      template: data.snapshot?.template,
      kind: data.snapshot?.kind,
      glossaryEnabled: data.snapshot?.glossaryEnabled,
      context: data.context,
      glossaryRevision: data.glossaryRevision ?? 0,
    }),
  )
}

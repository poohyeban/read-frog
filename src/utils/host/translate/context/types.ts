import type { ContextRequirements } from "@/utils/prompts/translation-template"

export type ContextScopeType =
  | "Document"
  | "Article"
  | "Section"
  | "FeedItem"
  | "Thread"
  | "Selection"
  | "Independent"
export interface ContextSource {
  source?: Node | null
  document?: Document
  kind?: "document" | "selection" | "independent"
  /** Captured text, never reconstructed from a later live selection. */
  text?: string
}
export interface ContextScope {
  readonly id: string
  readonly type: ContextScopeType
  readonly root: Element | Document | ShadowRoot | null
  readonly document: Document
  readonly dependencies: readonly Element[]
  readonly locator: string
  readonly confidence: "semantic" | "structural" | "local"
  readonly collection: boolean
  readonly sourceText?: string
}
export interface ContextSnapshot {
  readonly url: string
  readonly webTitle: string
  readonly webDescription: string
  readonly webContent: string
  readonly webSummary?: string
  readonly identity: string
  readonly fingerprint: string
  readonly documentIdentity: string
  readonly scopeIdentity: string
  readonly scopeType: ContextScopeType
  readonly version: number
  readonly requirements: Readonly<ContextRequirements>
  readonly provenance: Readonly<{
    confidence: ContextScope["confidence"]
    collection: boolean
    locator: string
    truncated: boolean
    createdAt: number
    summary: "none" | "verbatim" | "model"
  }>
}
export type InvalidityReason =
  | "owner-ended"
  | "route-changed"
  | "source-changed"
  | "source-detached"
  | "render-superseded"
  | "config-changed"
  | "context-stale"
export interface Validity {
  current: boolean
  reason?: InvalidityReason
}
export const NO_CONTEXT: Readonly<ContextRequirements> = Object.freeze({
  title: false,
  description: false,
  content: false,
  summary: false,
})
export const FULL_CONTEXT: Readonly<ContextRequirements> = Object.freeze({
  title: true,
  description: true,
  content: true,
  summary: false,
})

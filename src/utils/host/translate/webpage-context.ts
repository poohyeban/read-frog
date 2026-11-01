import type { ContextSnapshot, ContextSource } from "./context/types"
import type { WebPageContext } from "@/types/content"
import type { ContextRequirements } from "@/utils/prompts/translation-template"
import {
  captureDocumentLease,
  releaseDocumentIdentity,
  synchronizeDocumentIdentity,
} from "./context/document-lifetime"
import { ContextSnapshotManager, ContextStaleError } from "./context/snapshot-manager"
import { FULL_CONTEXT } from "./context/types"
export { resolveContextScope } from "./context/scope-resolver"
export { isInPageAnchorChange } from "./context/url"

// Structural compatibility for summary callers; V2 extraction always returns a
// ContextSnapshot. No runtime scope id enters the persistent translation key.
export interface CachedWebPageContext extends WebPageContext {
  url: string
  webContent: string
  readonly scopeType?: ContextSnapshot["scopeType"]
  readonly provenance?: ContextSnapshot["provenance"]
}
const manager = new ContextSnapshotManager()
const snapshots = new WeakSet<object>()
export function getContextDiagnostics() {
  return manager.inspect()
}
export function getDocumentContextSignal(): AbortSignal {
  return captureDocumentLease().signal
}
export function getWebPageContextSignal(_context: CachedWebPageContext): AbortSignal {
  // Navigation ends tasks. A local edit expires only future context reads.
  return getDocumentContextSignal()
}
/** Diagnostic provenance only, never a render or cancellation identity. */
export function getWebPageContentRevision(): number {
  manager.invalidation.flush()
  return manager.invalidation.metrics.invalidations
}
export function synchronizeWebPageContext(): void {
  synchronizeDocumentIdentity()
  manager.invalidation.flush()
}
export function invalidateWebPageContext(): void {
  manager.invalidateAll()
}
export function releaseWebPageContext(): void {
  manager.clear()
  releaseDocumentIdentity()
}
export function isWebPageContextCurrent(context: CachedWebPageContext): boolean {
  synchronizeWebPageContext()
  return snapshots.has(context) && manager.isCurrent(context as ContextSnapshot)
}
/** Compatibility for the existing host's batched mutation delivery. */
export function notePageContentMutations(_records: readonly MutationRecord[]): void {
  manager.invalidation.flush()
}
export async function getOrCreateWebPageContext(
  includeContent = true,
  signal?: AbortSignal,
  source: ContextSource & { requirements?: ContextRequirements } = {},
): Promise<ContextSnapshot | null> {
  if (typeof document === "undefined") return null
  const context = await manager.read(
    source,
    source.requirements ?? { ...FULL_CONTEXT, content: includeContent },
    signal,
  )
  snapshots.add(context)
  return context
}
export function isContextStaleError(error: unknown): error is ContextStaleError {
  return error instanceof ContextStaleError
}

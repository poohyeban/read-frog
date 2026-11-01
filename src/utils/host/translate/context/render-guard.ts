import type { TranslationTaskOwner } from "./task-owner"
import type { InvalidityReason, Validity } from "./types"
import { captureDocumentLease } from "./document-lifetime"

// Fixed reason cardinality; no source text, owner ids or DOM references retained.
const invalidities: Partial<Record<InvalidityReason, number>> = {}
export function getRenderInvalidityDiagnostics() {
  return { ...invalidities }
}
export interface RenderGuardInput {
  owner?: TranslationTaskOwner | null
  document?: Document
  configCurrent: () => boolean
  sourceCurrent: () => boolean
  sourceConnected?: () => boolean
  generationCurrent?: () => boolean
}
/** Context freshness is intentionally absent: a prompt snapshot is immutable.
 * A render belongs to an owner, a route and an exact source/generation. */
export function createRenderCommitGuard(input: RenderGuardInput) {
  const lease = captureDocumentLease(input.document)
  const validate = (): Validity => {
    if (!lease.isCurrent()) return { current: false, reason: "route-changed" }
    if (input.owner && !input.owner.isCurrent()) return { current: false, reason: "owner-ended" }
    if (!input.configCurrent()) return { current: false, reason: "config-changed" }
    if (input.sourceConnected && !input.sourceConnected())
      return { current: false, reason: "source-detached" }
    if (input.generationCurrent && !input.generationCurrent())
      return { current: false, reason: "render-superseded" }
    if (!input.sourceCurrent()) return { current: false, reason: "source-changed" }
    return { current: true }
  }
  const observed = new Set<InvalidityReason>()
  const reject = (reason: InvalidityReason): false => {
    if (!observed.has(reason)) {
      observed.add(reason)
      invalidities[reason] = (invalidities[reason] ?? 0) + 1
    }
    return false
  }
  const recordedValidation = () => {
    const result = validate()
    if (result.reason) reject(result.reason)
    return result
  }
  return {
    reject,
    signal: input.owner ? AbortSignal.any([lease.signal, input.owner.signal]) : lease.signal,
    validate: recordedValidation,
    isCurrent: () => recordedValidation().current,
  }
}

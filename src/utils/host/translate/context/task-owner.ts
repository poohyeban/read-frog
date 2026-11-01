import { ResourceScope } from "../resource-scope"
import { captureDocumentLease } from "./document-lifetime"

/** Ownership is a consumer lifetime, never a context-cache generation. */
export interface TranslationTaskOwner {
  readonly id: string
  readonly signal: AbortSignal
  isCurrent: () => boolean
}
export function createTranslationTaskOwner(feature: string, doc: Document = document) {
  const lease = captureDocumentLease(doc)
  const resources = new ResourceScope()
  const dispose = () => {
    resources.dispose()
  }
  lease.signal.addEventListener("abort", dispose, { once: true })
  resources.own(() => lease.signal.removeEventListener("abort", dispose))
  return Object.freeze({
    id: `${feature}-${crypto.randomUUID()}`,
    signal: resources.signal,
    isCurrent: () => !resources.signal.aborted && lease.isCurrent(),
    dispose,
  })
}

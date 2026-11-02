import { TranslationCancelledError } from "@/utils/request/cancellation"
import { isInPageAnchorChange } from "./url"

interface DocumentState {
  id: string
  route: number
  url: string
  controller: AbortController
  dispose: () => void
}
const documents = new WeakMap<Document, DocumentState>()
export interface DocumentLease {
  readonly documentIdentity: string
  readonly routeIdentity: string
  readonly url: string
  readonly signal: AbortSignal
  isCurrent: () => boolean
}
function stateFor(doc: Document): DocumentState {
  let state = documents.get(doc)
  if (state) return state
  const win = doc.defaultView
  const listeners: Array<() => void> = []
  state = {
    id: crypto.randomUUID(),
    route: 0,
    url: win?.location.href ?? doc.URL,
    controller: new AbortController(),
    dispose: () => {
      for (const remove of listeners) remove()
    },
  }
  documents.set(doc, state)
  const sync = () => synchronizeDocumentIdentity(doc)
  for (const event of ["extension:URLChange", "popstate", "hashchange"]) {
    win?.addEventListener(event, sync)
    listeners.push(() => win?.removeEventListener(event, sync))
  }
  const navigation = (win as (Window & { navigation?: EventTarget }) | null)?.navigation
  navigation?.addEventListener("currententrychange", sync)
  listeners.push(() => navigation?.removeEventListener("currententrychange", sync))
  const release = () => releaseDocumentIdentity(doc)
  win?.addEventListener("pagehide", release)
  listeners.push(() => win?.removeEventListener("pagehide", release))
  return state
}
export function synchronizeDocumentIdentity(doc: Document = document): void {
  const state = stateFor(doc)
  const url = doc.defaultView?.location.href ?? doc.URL
  if (state.url !== url && !isInPageAnchorChange(state.url, url, doc)) {
    state.controller.abort(new TranslationCancelledError())
    state.controller = new AbortController()
    state.route++
  }
  state.url = url
}
export function captureDocumentLease(doc: Document = document): DocumentLease {
  synchronizeDocumentIdentity(doc)
  const state = stateFor(doc)
  const signal = state.controller.signal
  return Object.freeze({
    documentIdentity: state.id,
    routeIdentity: `${state.id}:${state.route}`,
    url: state.url,
    signal,
    isCurrent: () => {
      if (signal.aborted) return false
      synchronizeDocumentIdentity(doc)
      return !signal.aborted && documents.get(doc) === state
    },
  })
}
export function releaseDocumentIdentity(doc: Document = document): void {
  const state = documents.get(doc)
  if (!state) return
  documents.delete(doc)
  state.controller.abort(new TranslationCancelledError())
  state.dispose()
}

import { getPageTranslationSession } from "./translation-session"
import { getWebPageContentRevision, isInPageAnchorChange } from "./webpage-context"

export interface CommitGate {
  readonly signal?: AbortSignal
  isCurrent: () => boolean
}

/** Capture once, before asynchronous preparation. Source-region checks remain
 * owned by the render mode, which knows its original nodes and restore records. */
export function captureCommitGate(sourceCurrent: () => boolean = () => true): CommitGate {
  const session = getPageTranslationSession()
  const revision = getWebPageContentRevision()
  const url = location.href
  return {
    signal: session?.signal,
    isCurrent: () =>
      (!session || session.isCurrent()) &&
      getWebPageContentRevision() === revision &&
      (location.href === url || isInPageAnchorChange(url, location.href)) &&
      sourceCurrent(),
  }
}

import { TranslationCancelledError } from "@/utils/request/cancellation"
import { translationActivity } from "./engine-state"
import { getPageTranslationSession } from "./translation-session"
import { getWebPageContentRevision, isInPageAnchorChange } from "./webpage-context"

export interface CommitGate {
  readonly signal?: AbortSignal
  isCurrent: () => boolean
  beginCommit: () => { complete: () => void; discard: () => void }
}

/** Capture once, before asynchronous preparation. Source-region checks remain
 * owned by the render mode, which knows its original nodes and restore records. */
export function captureCommitGate(sourceCurrent: () => boolean = () => true): CommitGate {
  const session = getPageTranslationSession()
  const revision = getWebPageContentRevision()
  const url = location.href
  return {
    signal: session?.signal,
    beginCommit: () => {
      const finish = translationActivity.track("render", session?.id)
      return {
        complete: () => finish(),
        discard: () => finish(new TranslationCancelledError(session?.id)),
      }
    },
    isCurrent: () =>
      (!session || session.isCurrent()) &&
      getWebPageContentRevision() === revision &&
      (location.href === url || isInPageAnchorChange(url, location.href)) &&
      sourceCurrent(),
  }
}

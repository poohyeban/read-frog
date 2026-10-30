import type { Config } from "@/types/config/config"
import { captureTranslationConfigValidity } from "@/utils/config/snapshot-revision"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { translationActivity } from "./engine-state"
import { getPageTranslationSession } from "./translation-session"
import {
  getWebPageContentRevision,
  isInPageAnchorChange,
  synchronizeWebPageContext,
} from "./webpage-context"

export interface CommitGate {
  readonly signal?: AbortSignal
  isCurrent: () => boolean
  beginCommit: () => { complete: () => void; discard: () => void; fail: (error: unknown) => void }
}

/** Capture once, before asynchronous preparation. Source-region checks remain
 * owned by the render mode, which knows its original nodes and restore records. */
export function captureCommitGate(
  sourceCurrent: () => boolean = () => true,
  config?: Config,
): CommitGate {
  synchronizeWebPageContext()
  const configCurrent = captureTranslationConfigValidity(config)
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
        fail: finish,
      }
    },
    isCurrent: () =>
      configCurrent() &&
      (!session || session.isCurrent()) &&
      getWebPageContentRevision() === revision &&
      (location.href === url || isInPageAnchorChange(url, location.href)) &&
      sourceCurrent(),
  }
}

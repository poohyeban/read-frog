import type { TranslationTaskOwner } from "./context/task-owner"
import type { InvalidityReason, Validity } from "./context/types"
import type { Config } from "@/types/config/config"
import { captureTranslationConfigValidity } from "@/utils/config/snapshot-revision"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { createRenderCommitGuard } from "./context/render-guard"
import { translationActivity } from "./engine-state"
import { getPageTranslationSession } from "./translation-session"

export interface CommitGate {
  readonly signal?: AbortSignal
  readonly owner?: TranslationTaskOwner | null
  reject: (reason: InvalidityReason) => false
  validate: () => Validity
  isCurrent: () => boolean
  beginCommit: () => { complete: () => void; discard: () => void; fail: (error: unknown) => void }
}

/** Source snapshots, DOM ownership and render generations remain owned by the
 * render mode. Explicit independent owners never inherit the page session. */
export function captureCommitGate(
  sourceCurrent: () => boolean = () => true,
  config?: Config,
  owner: TranslationTaskOwner | null = getPageTranslationSession() ?? null,
): CommitGate {
  const guard = createRenderCommitGuard({
    owner,
    configCurrent: captureTranslationConfigValidity(config),
    sourceCurrent,
  })
  return {
    ...guard,
    owner,
    beginCommit: () => {
      const finish = translationActivity.track("render", owner?.id)
      return {
        complete: () => finish(),
        discard: () => finish(new TranslationCancelledError(owner?.id)),
        fail: finish,
      }
    },
  }
}

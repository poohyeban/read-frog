import type { TranslationPlan } from "./translation-plan"
import { isNoTranslationSentinel } from "@/utils/constants/prompt"
import { sendMessage } from "@/utils/message"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { translationActivity } from "./engine-state"
import {
  assertHtmlAttributeMarkerIntegrity,
  isHtmlAttributeMarkerIntegrityError,
} from "./html-attribute-markers"
import {
  getInMemoryTranslation,
  removeInMemoryTranslation,
  storeInMemoryTranslation,
} from "./in-memory-translation-cache"
import { auditInlineAtomTokens } from "./inline-atom-tokens"
import { cancelTranslationScope } from "./request-cancellation"

export interface ValidatedTranslationResult {
  readonly text: string
  readonly rawText: string
  readonly cacheable: boolean
  readonly origin: "memory" | "provider"
}
export function validateTranslationResult(
  plan: TranslationPlan,
  text: string,
  origin: ValidatedTranslationResult["origin"],
): ValidatedTranslationResult {
  const sentinel = isNoTranslationSentinel(text)
  if (plan.validation.htmlAttributes && !sentinel)
    assertHtmlAttributeMarkerIntegrity(plan.request.text, text)
  return {
    text: sentinel ? "" : text,
    rawText: text,
    origin,
    cacheable:
      !!text &&
      (sentinel ||
        !plan.validation.inlineAtoms ||
        auditInlineAtomTokens(plan.request.text, text).ok),
  }
}

/** Network and cache execution know nothing about DOM wrappers or UI components. */
export async function executeTranslationPlan(
  plan: TranslationPlan,
  lifetime: { signal?: AbortSignal; isCurrent: () => boolean; activitySessionId?: string },
): Promise<ValidatedTranslationResult> {
  const assertCurrent = () => {
    if (lifetime.signal?.aborted || !lifetime.isCurrent())
      throw new TranslationCancelledError(plan.scope.id)
  }
  const finish = translationActivity.track(
    "request",
    lifetime.activitySessionId ?? (plan.scope.kind === "page" ? plan.scope.id : undefined),
  )
  try {
    assertCurrent()
    const { hash, forceRetranslation } = plan.request
    if (plan.scope.kind === "page" && !forceRetranslation) {
      const hit = getInMemoryTranslation(hash)
      if (hit !== undefined) {
        try {
          const result = validateTranslationResult(plan, hit, "memory")
          if (result.cacheable) return result
        } catch (error) {
          if (!isHtmlAttributeMarkerIntegrityError(error)) throw error
        }
        removeInMemoryTranslation(hash)
      }
    }
    let rejectCancelled!: (error: Error) => void
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = reject
    })
    const cancel = () => {
      rejectCancelled(new TranslationCancelledError(plan.scope.id))
      void cancelTranslationScope(plan.scope.id, lifetime.signal).catch(() => {})
    }
    lifetime.signal?.addEventListener("abort", cancel, { once: true })
    try {
      const text = await Promise.race([
        cancelled,
        sendMessage("enqueueTranslateRequest", {
          ...structuredClone(plan.request),
          scheduleAt: Date.now(),
        }),
      ])
      assertCurrent()
      const result = validateTranslationResult(plan, text, "provider")
      if (plan.scope.kind === "page" && result.cacheable)
        storeInMemoryTranslation(hash, result.rawText)
      return result
    } finally {
      lifetime.signal?.removeEventListener("abort", cancel)
    }
  } catch (error) {
    finish(error)
    throw error
  } finally {
    finish()
  }
}

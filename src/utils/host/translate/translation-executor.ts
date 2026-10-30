import type { TranslationPlan } from "./translation-plan"
import { isNoTranslationSentinel } from "@/utils/constants/prompt"
import { sendMessage } from "@/utils/message"
import { TranslationCancelledError } from "@/utils/request/cancellation"
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
  lifetime: { signal?: AbortSignal; isCurrent: () => boolean },
): Promise<ValidatedTranslationResult> {
  const assertCurrent = () => {
    if (lifetime.signal?.aborted || !lifetime.isCurrent())
      throw new TranslationCancelledError(plan.scope.id)
  }
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
  const cancel = () => {
    void sendMessage("cancelPageTranslationRequests", { sessionId: plan.scope.id }).catch(() => {})
  }
  lifetime.signal?.addEventListener("abort", cancel, { once: true })
  try {
    const text = await sendMessage("enqueueTranslateRequest", {
      ...structuredClone(plan.request),
      scheduleAt: Date.now(),
    })
    assertCurrent()
    const result = validateTranslationResult(plan, text, "provider")
    if (plan.scope.kind === "page" && result.cacheable)
      storeInMemoryTranslation(hash, result.rawText)
    return result
  } finally {
    lifetime.signal?.removeEventListener("abort", cancel)
  }
}

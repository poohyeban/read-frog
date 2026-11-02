import type { TranslationPromptConfig } from "@/utils/prompts/translation-template"
import { BUILT_IN_PAGE_TRANSLATE_PROMPTS } from "@/utils/constants/prompt"
import { getContextRequirements } from "@/utils/prompts/translation-template"
import { captureDocumentLease } from "./document-lifetime"

export class SummaryConsentRequiredError extends Error {
  readonly code = "CONTEXT_SUMMARY_CONSENT_REQUIRED"
  readonly actionLabel = "Allow this source's model summary"
  constructor(readonly authorize: () => void) {
    super(
      "This prompt needs a model summary for another source. Allow its additional summary request, then retry translation. Your provider's normal charges may apply.",
    )
    this.name = "SummaryConsentRequiredError"
  }
}
interface Admission {
  automaticKey?: string
  allowed: Map<string, true>
}
const routes = new WeakMap<AbortSignal, Admission>()
/** A semantic cost consent ledger, not a physical limiter or retry mechanism.
 * All admitted work still uses the existing shared queue and ResourceScheduler. */
export function requireSummaryAdmission(key: string): void {
  const lease = captureDocumentLease()
  let admission = routes.get(lease.signal)
  if (!admission) {
    admission = { allowed: new Map() }
    routes.set(lease.signal, admission)
  }
  if (!admission.automaticKey) admission.automaticKey = key
  if (admission.automaticKey === key || admission.allowed.has(key)) return
  const captured = admission
  throw new SummaryConsentRequiredError(() => {
    if (!lease.isCurrent()) return
    captured.allowed.delete(key)
    captured.allowed.set(key, true)
    while (captured.allowed.size > 128)
      captured.allowed.delete(captured.allowed.keys().next().value!)
  })
}
/** A user-authored summary token is an explicit semantic requirement. Built-in
 * contextual prompts accept complete short source context without a model. */
export function requiresModelSummary(config: TranslationPromptConfig): boolean {
  const id = config.customPromptsConfig.promptId
  return (
    !!id &&
    !Object.hasOwn(BUILT_IN_PAGE_TRANSLATE_PROMPTS, id) &&
    config.customPromptsConfig.patterns.some((pattern) => pattern.id === id) &&
    getContextRequirements(config).summary
  )
}

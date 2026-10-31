import { SUBTITLE_WORK_LIMITS, SubtitleWorkRejected } from "./work-policy"

export interface BudgetLedger {
  key: string
  requests: number
  estimatedTokens: number
  speculativeRequests: number
  speculativeTokens: number
  actualInputTokens: number
  actualOutputTokens: number
  usageReports: number
}
export interface BudgetAttempt {
  key: string
  count: number
}
export interface BudgetReservation {
  budget: string
  keys: string[]
  tokens: number
  urgent: boolean
  maxRequests: number
  maxTokens: number
  emergencyPercent: number
}
export function emptyBudget(key: string): BudgetLedger {
  return {
    key,
    requests: 0,
    estimatedTokens: 0,
    speculativeRequests: 0,
    speculativeTokens: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    usageReports: 0,
  }
}

/** Called inside the persistence transaction: checks and debits cannot race. */
export function reserveBudget(
  ledger: BudgetLedger,
  attempts: BudgetAttempt[],
  request: BudgetReservation,
): void {
  const fraction = 1 - request.emergencyPercent / 100
  const actual = ledger.actualInputTokens + ledger.actualOutputTokens
  if (
    ledger.requests + 1 > request.maxRequests ||
    Math.max(ledger.estimatedTokens, actual) + request.tokens > request.maxTokens
  )
    throw new SubtitleWorkRejected("hard-budget")
  if (
    !request.urgent &&
    (ledger.speculativeRequests + 1 > Math.floor(request.maxRequests * fraction) ||
      ledger.speculativeTokens + request.tokens > Math.floor(request.maxTokens * fraction))
  )
    throw new SubtitleWorkRejected("soft-budget")
  if (attempts.some((a) => a.count >= SUBTITLE_WORK_LIMITS.attempts))
    throw new SubtitleWorkRejected("attempts")
  ledger.requests++
  ledger.estimatedTokens += request.tokens
  if (!request.urgent) {
    ledger.speculativeRequests++
    ledger.speculativeTokens += request.tokens
  }
  for (const attempt of attempts) attempt.count++
}

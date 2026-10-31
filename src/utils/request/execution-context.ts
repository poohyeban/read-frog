import type { AttemptContext } from "./attempt-context"
import type { ResourcePolicy } from "./resource-policy"

export interface RequestExecutionContext {
  attempts: AttemptContext
  priority: number
  consumer: string
  requestKey: string
  timeoutMs?: number
  policy?: ResourcePolicy
  physicalSettled?: Promise<void>
  resourceId?: string
  promote?: (priority: number) => void
  abort: (reason: unknown) => void
}
const contexts = new WeakMap<AbortSignal, RequestExecutionContext>()
export function bindExecutionContext(signal: AbortSignal, context: RequestExecutionContext) {
  contexts.set(signal, context)
}
export function getExecutionContext(signal?: AbortSignal) {
  return signal ? contexts.get(signal) : undefined
}

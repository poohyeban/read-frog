import { sendMessage } from "@/utils/message"

// A stop can reject hundreds of consumers of the same page scope. The owner
// signal is weakly held; one backend cancellation message drains that scope.
const dispatched = new WeakMap<AbortSignal, Set<string>>()
export function cancelTranslationScope(scopeId: string, signal?: AbortSignal): Promise<void> {
  if (signal) {
    const scopes = dispatched.get(signal) ?? new Set<string>()
    if (scopes.has(scopeId)) return Promise.resolve()
    scopes.add(scopeId)
    dispatched.set(signal, scopes)
  }
  return sendMessage("cancelPageTranslationRequests", { sessionId: scopeId })
}

import type { Config } from "@/types/config/config"

/** Frame-local lifetime owner. DOM and network execution stay in their layers. */
export interface PageSession {
  readonly id: string
  readonly signal: AbortSignal
  readonly config?: Config
}
type SessionState =
  | { status: "idle" }
  | { status: "active"; session: PageSession; controller: AbortController }
let state: SessionState = { status: "idle" }
let sessionCounter = 0

export function beginPageTranslationSession(config?: Config): string {
  endPageTranslationSession()
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${++sessionCounter}`
  const controller = new AbortController()
  state = {
    status: "active",
    controller,
    session: Object.freeze({ id, signal: controller.signal, config }),
  }
  return id
}
export function endPageTranslationSession(): string | null {
  if (state.status === "idle") return null
  const previous = state
  state = { status: "idle" }
  previous.controller.abort()
  return previous.session.id
}
export function getPageTranslationSession(): PageSession | undefined {
  return state.status === "active" ? state.session : undefined
}
export function getPageTranslationSessionId(): string | null {
  return getPageTranslationSession()?.id ?? null
}

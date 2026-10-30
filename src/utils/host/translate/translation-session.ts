import type { Config } from "@/types/config/config"
import { logger } from "@/utils/logger"
import { translationActivity } from "./engine-state"
import { ResourceScope } from "./resource-scope"

/** Captured task epoch. Routing replaces it; document resources survive until stop. */
export interface PageSession {
  readonly id: string
  readonly signal: AbortSignal
  readonly lifetimeSignal: AbortSignal
  readonly config?: Config
  readonly version: number
  readonly documentRevision: number
  isCurrent: () => boolean
  own: (dispose: () => void) => () => void
}
type SessionState =
  | { status: "idle" }
  | {
      status: "active"
      session: PageSession
      tasks: ResourceScope
      resources: ResourceScope
      readRevision: () => number
    }
let state: SessionState = { status: "idle" }
let generation = 0
let epoch = 0

function activate(
  config: Config | undefined,
  resources: ResourceScope,
  readRevision: () => number,
): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${++epoch}`
  const tasks = new ResourceScope()
  const session: PageSession = Object.freeze({
    id,
    signal: tasks.signal,
    lifetimeSignal: resources.signal,
    config: config && structuredClone(config),
    version: generation,
    get documentRevision() {
      return readRevision()
    },
    isCurrent: () => state.status === "active" && state.session.id === id && !tasks.signal.aborted,
    own: (dispose: () => void) => resources.own(dispose),
  })
  state = { status: "active", session, tasks, resources, readRevision }
  translationActivity.begin(id)
  return id
}
export function beginPageTranslationSession(
  config?: Config,
  readRevision: () => number = () => 0,
): string {
  endPageTranslationSession()
  generation++
  return activate(config, new ResourceScope(), readRevision)
}
/** Cancel old requests on navigation without destroying retained DOM observers. */
export function replacePageTranslationSession(config?: Config): string | null {
  if (state.status === "idle") return null
  const previous = state
  previous.tasks.dispose()
  activate(config, previous.resources, previous.readRevision)
  return previous.session.id
}
export function endPageTranslationSession(): string | null {
  if (state.status === "idle") return null
  const previous = state
  state = { status: "idle" }
  translationActivity.end(previous.session.id)
  generation++
  const errors = [...previous.tasks.dispose(), ...previous.resources.dispose()]
  if (errors.length) logger.warn("Session resource cleanup failed", errors)
  return previous.session.id
}
export function getPageTranslationSession(): PageSession | undefined {
  return state.status === "active" ? state.session : undefined
}
export function getPageTranslationSessionVersion(): number {
  return generation
}
export function getPageTranslationSessionId(): string | null {
  return getPageTranslationSession()?.id ?? null
}

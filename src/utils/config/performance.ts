import type { PerformanceOverrides } from "@/utils/request/performance-config"
import { storage } from "#imports"
import {
  effectivePerformance,
  emptyPerformanceOverrides,
  PERFORMANCE_STORAGE_KEY,
  validatePerformanceOverrides,
} from "@/utils/request/performance-config"

let overrides = emptyPerformanceOverrides()
let effective = effectivePerformance(overrides)
let initializing: Promise<void> | undefined
let generation = 0
let watching = false
const listeners = new Set<() => void>()

function accept(value: unknown) {
  const next =
    value === null || value === undefined
      ? emptyPerformanceOverrides()
      : validatePerformanceOverrides(value)
  overrides = next
  effective = effectivePerformance(next)
  for (const listener of listeners) listener()
}
/** Context-local immutable snapshots: never reads storage on a playback/render hot path. */
export function getPerformanceOverrides() {
  return overrides
}
export function getPerformanceSnapshot() {
  return effective
}
export function watchPerformance(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function initializePerformance() {
  if (!initializing)
    initializing = (async () => {
      if (!watching) {
        watching = true
        storage.watch<PerformanceOverrides>(PERFORMANCE_STORAGE_KEY, (value) => {
          generation++
          try {
            accept(value)
          } catch {
            /* Keep the last valid snapshot; never rewrite user storage on read. */
          }
        })
      }
      const revision = generation
      const value = await storage.getItem(PERFORMANCE_STORAGE_KEY)
      if (revision === generation) accept(value)
    })().catch((error) => {
      initializing = undefined
      throw error
    })
  return initializing
}

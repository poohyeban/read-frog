import { afterEach, describe, expect, it, vi } from "vitest"
import { ResourceScope } from "../resource-scope"
import {
  beginPageTranslationSession,
  endPageTranslationSession,
  getPageTranslationSession,
  replacePageTranslationSession,
} from "../translation-session"

afterEach(() => endPageTranslationSession())
describe("session resource ownership", () => {
  it("replaces task epochs on navigation and disposes document resources exactly once on stop", () => {
    let revision = 2
    beginPageTranslationSession(undefined, () => revision)
    const first = getPageTranslationSession()!
    const cleanup = vi.fn<() => void>()
    first.own(cleanup)
    revision++
    expect(first.documentRevision).toBe(3)
    expect(replacePageTranslationSession()).toBe(first.id)
    const next = getPageTranslationSession()!
    expect(first.isCurrent()).toBe(false)
    expect(first.signal.aborted).toBe(true)
    expect(first.lifetimeSignal.aborted).toBe(false)
    expect(next.lifetimeSignal).toBe(first.lifetimeSignal)
    expect(next.isCurrent()).toBe(true)
    expect(cleanup).not.toHaveBeenCalled()
    endPageTranslationSession()
    endPageTranslationSession()
    expect(next.signal.aborted).toBe(true)
    expect(next.lifetimeSignal.aborted).toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
  it("runs all teardown callbacks even when one fails, and releases references", () => {
    const owner = new ResourceScope()
    const dispose = vi.fn<() => void>()
    owner.own(dispose)
    owner.own(() => {
      throw new Error("broken cleanup")
    })
    expect(owner.dispose()).toHaveLength(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(owner.size).toBe(0)
    expect(owner.signal.aborted).toBe(true)
  })
})

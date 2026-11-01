// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { captureDocumentLease, releaseDocumentIdentity } from "../document-lifetime"
import { createRenderCommitGuard } from "../render-guard"
import { ContextSnapshotManager, ContextStaleError } from "../snapshot-manager"
import { createTranslationTaskOwner } from "../task-owner"
import { FULL_CONTEXT } from "../types"

afterEach(() => releaseDocumentIdentity())
it("reports separate owner, route, config, source and render generation reasons", () => {
  const owner = createTranslationTaskOwner("test")
  let config = true,
    source = true,
    connected = true,
    generation = true
  const guard = createRenderCommitGuard({
    owner,
    configCurrent: () => config,
    sourceCurrent: () => source,
    sourceConnected: () => connected,
    generationCurrent: () => generation,
  })
  expect(guard.validate()).toEqual({ current: true })
  generation = false
  expect(guard.validate().reason).toBe("render-superseded")
  generation = true
  source = false
  expect(guard.validate().reason).toBe("source-changed")
  source = true
  connected = false
  expect(guard.validate().reason).toBe("source-detached")
  connected = true
  config = false
  expect(guard.validate().reason).toBe("config-changed")
  config = true
  owner.dispose()
  expect(guard.validate().reason).toBe("owner-ended")
  window.history.pushState({}, "", "/changed-route")
  expect(guard.validate().reason).toBe("route-changed")
})
it("route owners survive real anchors but expire on query/hash navigation and pagehide", () => {
  document.body.innerHTML = '<h1 id="section">Source heading</h1>'
  window.history.replaceState({}, "", "/article")
  const original = captureDocumentLease()
  window.history.pushState({}, "", "/article#section")
  expect(original.isCurrent()).toBe(true)
  window.history.pushState({}, "", "/article?other=1")
  expect(original.isCurrent()).toBe(false)
  const next = captureDocumentLease()
  window.history.replaceState({}, "", "/article")
  window.dispatchEvent(new PopStateEvent("popstate"))
  expect(next.signal.aborted).toBe(true)
  const restored = captureDocumentLease()
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }))
  expect(restored.isCurrent()).toBe(false)
  expect(captureDocumentLease().documentIdentity).not.toBe(restored.documentIdentity)
})
it("context-stale affects future reads, never an issued prompt or unchanged unit", async () => {
  document.body.innerHTML =
    "<article><p>Original source.</p><aside>Related context</aside></article>"
  const source = document.querySelector("p")!
  const manager = new ContextSnapshotManager()
  const snapshot = await manager.read({ source }, FULL_CONTEXT)
  const guard = createRenderCommitGuard({
    configCurrent: () => true,
    sourceCurrent: () => source.textContent === "Original source.",
    sourceConnected: () => source.isConnected,
  })
  document.querySelector("aside")!.textContent = "Updated context for future requests"
  expect(manager.isCurrent(snapshot)).toBe(false)
  expect(new ContextStaleError().reason).toBe("context-stale")
  expect(guard.validate()).toEqual({ current: true })
  expect(snapshot.webContent).not.toContain("Updated context")
  manager.clear()
})

it("checking an ended document lease does not resurrect route listeners", () => {
  const lease = captureDocumentLease()
  window.dispatchEvent(new PageTransitionEvent("pagehide"))
  const add = vi.spyOn(window, "addEventListener")
  try {
    for (let i = 0; i < 100; i++) expect(lease.isCurrent()).toBe(false)
    expect(add).not.toHaveBeenCalled()
  } finally {
    add.mockRestore()
  }
})

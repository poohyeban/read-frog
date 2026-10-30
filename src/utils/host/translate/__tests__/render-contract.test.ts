// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { DOMBatcher } from "../../dom/batch-dom"
import { captureCommitGate } from "../commit-gate"
import {
  beginPageTranslationSession,
  endPageTranslationSession,
  replacePageTranslationSession,
  getPageTranslationSession,
} from "../translation-session"
import { getOrCreateWebPageContext, releaseWebPageContext } from "../webpage-context"

afterEach(() => {
  endPageTranslationSession()
  releaseWebPageContext()
  vi.restoreAllMocks()
})
it("rejects route, document and source-region changes even before a cached result commits", async () => {
  document.body.innerHTML = "<main><p>Source text</p></main>"
  beginPageTranslationSession()
  await getOrCreateWebPageContext(false)
  const source = document.querySelector("p")!
  const gate = captureCommitGate(() => source.isConnected && source.textContent === "Source text")
  expect(gate.isCurrent()).toBe(true)
  document.querySelector("main")!.insertAdjacentHTML("beforeend", "<p>Append only</p>")
  await Promise.resolve()
  expect(gate.isCurrent()).toBe(true)
  source.textContent = "Edited text"
  expect(gate.isCurrent()).toBe(false)
  const documentGate = captureCommitGate()
  document.querySelector("main")!.replaceChildren(document.createElement("article"))
  await Promise.resolve()
  expect(documentGate.isCurrent()).toBe(false)
  const routeGate = captureCommitGate()
  replacePageTranslationSession()
  expect(routeGate.isCurrent()).toBe(false)
})
it("bounds each DOM frame and releases all pending writes on stop", () => {
  let now = 0
  vi.spyOn(performance, "now").mockImplementation(() => now)
  const frames: FrameRequestCallback[] = []
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {})
  const batch = new DOMBatcher(4)
  beginPageTranslationSession()
  const signal = getPageTranslationSession()!.signal
  let applied = 0
  let discarded = 0
  for (let i = 0; i < 30; i++)
    batch.queue(
      () => {
        applied++
        now += 2
      },
      {
        signal,
        onDiscard: () => {
          discarded++
        },
      },
    )
  frames.shift()!(0)
  expect(applied).toBe(2)
  expect(batch.pending).toBe(28)
  endPageTranslationSession()
  expect(batch.pending).toBe(0)
  expect(discarded).toBe(28)
  frames.shift()!(0)
  expect(applied).toBe(2)
})

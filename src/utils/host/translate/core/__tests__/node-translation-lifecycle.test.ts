// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RetryButton } from "@/components/translation/error/retry-button"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { CONTENT_WRAPPER_CLASS, TRANSLATION_ONLY_ATTRIBUTE } from "@/utils/constants/dom-labels"
import { flushBatchedOperations } from "../../../dom/batch-dom"
import {
  removeAllTranslatedWrapperNodes,
  removeOrShowNodeTranslation,
} from "../../node-manipulation"
import { beginPageTranslationSession, endPageTranslationSession } from "../../translation-session"
import { cleanupNodeTranslations } from "../node-translation-lifecycle"
import { translateNodesBilingualMode } from "../translation-modes"
import {
  findStaleBilingualLayoutSource,
  getPendingBilingualTranslationStates,
  getPendingVirtualParagraphGroups,
} from "../translation-state"

const { translate, filter } = vi.hoisted(() => ({
  translate: vi.fn<(text: string) => Promise<string>>(),
  filter: vi.fn<() => Promise<boolean>>(),
}))
vi.mock("@/utils/host/translate/translate-variants", () => ({ translateTextForPage: translate }))
vi.mock("@/utils/host/translate/ui/translation-config-feedback", () => ({
  validateTranslationConfigAndToast: () => true,
}))
vi.mock("@/utils/host/translate/filter-small-paragraph", () => ({
  shouldFilterSmallParagraph: filter,
}))
vi.mock("@/utils/host/translate/target-language-skip", () => ({
  shouldSkipAsTargetLanguage: async () => false,
}))

function config(mode: "bilingual" | "translationOnly" = "bilingual") {
  const value = structuredClone(DEFAULT_CONFIG)
  value.pageTranslation.mode = mode
  return value
}

function paragraph(html = "Previous article heading", parent: ParentNode = document.body) {
  const element = document.createElement("p")
  element.innerHTML = html
  element.getClientRects = () => [{ width: 500, height: 30 }] as unknown as DOMRectList
  parent.appendChild(element)
  return element
}

async function settle() {
  flushBatchedOperations()
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushBatchedOperations()
  await Promise.resolve()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("hover translation lifecycle on dynamic pages", () => {
  beforeEach(() => {
    document.body.replaceChildren()
    translate.mockReset().mockResolvedValue("上一个标题的译文")
    filter.mockReset().mockResolvedValue(false)
  })

  afterEach(async () => {
    cleanup()
    endPageTranslationSession()
    cleanupNodeTranslations()
    removeAllTranslatedWrapperNodes()
    await settle()
    vi.restoreAllMocks()
  })

  it.each(["edit", "replace"])(
    "removes stale bilingual text after a host text %s without another request",
    async (change) => {
      const source = paragraph()
      const original = source.firstChild!
      await removeOrShowNodeTranslation(source, config())
      await settle()
      expect(source.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).not.toBeNull()
      if (change === "edit") original.textContent = "New article heading"
      else {
        original.remove()
        source.append("New article heading")
      }
      await settle()
      expect(source.textContent).toBe("New article heading")
      expect(translate).toHaveBeenCalledTimes(1)
      // Fresh hover translates the new source instead of toggling an orphan off.
      await removeOrShowNodeTranslation(source, config())
      expect(translate.mock.calls[1]?.[0]).toBe("New article heading")
    },
  )

  it("keeps valid translations through unrelated mutations and source reparenting", async () => {
    const source = paragraph()
    await removeOrShowNodeTranslation(source, config())
    const wrapper = source.querySelector(`.${CONTENT_WRAPPER_CLASS}`)!
    source.firstChild!.replaceWith(
      Object.assign(document.createElement("em"), { textContent: "Previous article heading" }),
    )
    paragraph("Unrelated ticker changed")
    const container = document.createElement("section")
    document.body.append(container)
    container.append(source)
    await settle()
    expect(wrapper.isConnected).toBe(true)
    expect(translate).toHaveBeenCalledTimes(1)
  })

  it("expires detached content before a virtualized site reuses it", async () => {
    const source = paragraph()
    await removeOrShowNodeTranslation(source, config())
    source.remove()
    await settle()
    document.body.append(source)
    source.firstChild!.textContent = "Reused card heading"
    expect(source.textContent).toBe("Reused card heading")
    expect(source.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).toBeNull()
  })

  it("follows a translated node moved into a newly attached shadow tree", async () => {
    const source = paragraph()
    await removeOrShowNodeTranslation(source, config())
    const host = document.createElement("div")
    document.body.append(host)
    host.attachShadow({ mode: "open" }).append(source)
    await settle()
    expect(source.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).not.toBeNull()
    source.firstChild!.textContent = "Updated after moving into a shadow tree"
    await settle()
    expect(source.textContent).toBe("Updated after moving into a shadow tree")
  })

  it("observes nested shadow roots and releases translations when their host disappears", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const shadow = host.attachShadow({ mode: "open" })
    const innerHost = document.createElement("div")
    shadow.append(innerHost)
    const source = paragraph(undefined, innerHost.attachShadow({ mode: "open" }))
    await removeOrShowNodeTranslation(source, config())
    source.firstChild!.textContent = "New shadow heading"
    await settle()
    expect(source.textContent).toBe("New shadow heading")
    await removeOrShowNodeTranslation(source, config())
    host.remove()
    await settle()
    expect(source.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).toBeNull()
  })

  it("drops late provider output after the host reuses the source", async () => {
    const request = deferred<string>()
    translate.mockReturnValue(request.promise)
    const source = paragraph()
    const running = removeOrShowNodeTranslation(source, config())
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1))
    source.firstChild!.textContent = "Latest heading"
    await settle()
    expect(source.textContent).toBe("Latest heading")
    request.resolve("Obsolete result")
    await running
    await settle()
    expect(source.textContent).toBe("Latest heading")
  })

  it("keeps manual retry results in the same source-lifecycle checks", async () => {
    const source = paragraph()
    await removeOrShowNodeTranslation(source, config())
    const view = render(createElement(RetryButton, { nodes: [source] }))
    fireEvent.click(view.getByRole("button"))
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(2))
    await settle()
    expect(source.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).not.toBeNull()
    source.firstChild!.textContent = "Site update after retry"
    await settle()
    expect(source.textContent).toBe("Site update after retry")
  })

  it("does not translate a new source when the old hover was still filtering", async () => {
    const filtering = deferred<boolean>()
    filter.mockReturnValue(filtering.promise)
    const source = paragraph()
    const running = removeOrShowNodeTranslation(source, config())
    await vi.waitFor(() => expect(filter).toHaveBeenCalled())
    source.firstChild!.textContent = "New source during filtering"
    filtering.resolve(false)
    await running
    await settle()
    expect(translate).not.toHaveBeenCalled()
    expect(source.textContent).toBe("New source during filtering")
  })

  it("leaves another hover and a page-owned translation intact", async () => {
    const first = paragraph()
    const second = paragraph("Second source heading")
    const pageOwned = paragraph("Page-owned heading")
    await removeOrShowNodeTranslation(first, config())
    await removeOrShowNodeTranslation(second, config())
    await translateNodesBilingualMode([pageOwned], "page-owned-walk", config())
    first.firstChild!.textContent = "Updated first heading"
    await settle()
    expect(first.textContent).toBe("Updated first heading")
    expect(second.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).not.toBeNull()
    expect(pageOwned.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).not.toBeNull()
    cleanupNodeTranslations()
    expect(pageOwned.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).not.toBeNull()
  })

  it("preserves host edits when a translation-only text swap expires", async () => {
    const source = paragraph()
    const original = source.firstChild!
    await removeOrShowNodeTranslation(source, config("translationOnly"))
    await settle()
    expect(source.textContent).toBe("上一个标题的译文")
    original.textContent = "Current title from the site"
    await settle()
    expect(source.textContent).toBe("Current title from the site")
    expect(source.hasAttribute(TRANSLATION_ONLY_ATTRIBUTE)).toBe(false)
    expect(translate).toHaveBeenCalledTimes(1)
  })

  it("does not resurrect displaced originals when the site replaces a fallback translation", async () => {
    const source = paragraph("<b>Previous</b> article heading")
    await removeOrShowNodeTranslation(source, config("translationOnly"))
    await settle()
    expect(source.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).not.toBeNull()
    source.append("New article heading")
    await settle()
    expect(source.textContent).toBe("New article heading")
  })

  it("disconnects the shared observer after the final hover is toggled off", async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect")
    const source = paragraph()
    await removeOrShowNodeTranslation(source, config())
    await settle()
    disconnect.mockClear()
    await removeOrShowNodeTranslation(source, config())
    await settle()
    expect(disconnect).toHaveBeenCalled()
    expect(source.textContent).toBe("Previous article heading")
  })

  it("hands a stale hover source to the active page translation without erasing its state", async () => {
    const source = paragraph()
    await removeOrShowNodeTranslation(source, config())
    beginPageTranslationSession()
    source.firstChild!.textContent = "Updated page paragraph"
    await settle()
    expect(findStaleBilingualLayoutSource(source)).toBe(source)
    translate.mockResolvedValue("更新后的段落译文")
    await translateNodesBilingualMode([source], "page-session-walk", config())
    await settle()
    expect(source.textContent).toContain("更新后的段落译文")
    expect(source.textContent).not.toContain("上一个标题的译文")
  })

  it.each(["bilingual", "translationOnly"] as const)(
    "cleans a segmented %s paragraph when a framework rewrites its original text node",
    async (mode) => {
      const source = paragraph(
        "First paragraph has enough words.\n\nSecond paragraph has enough words.",
      )
      source.style.whiteSpace = "pre-wrap"
      const originalText = source.firstChild!
      await removeOrShowNodeTranslation(source, config(mode))
      await settle()
      expect(translate).toHaveBeenCalledTimes(2)
      originalText.textContent = "Fresh complete article text"
      await settle()
      expect(source.textContent).toBe("Fresh complete article text")
      expect(source.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).toBeNull()
      expect(source.hasAttribute(TRANSLATION_ONLY_ATTRIBUTE)).toBe(false)
    },
  )

  it.each([false, true])(
    "cancels filtering at runtime teardown (segmented: %s)",
    async (segmented) => {
      const filtering = deferred<boolean>()
      filter.mockReturnValue(filtering.promise)
      const source = paragraph(
        segmented ? "First long paragraph.\n\nSecond long paragraph." : undefined,
      )
      if (segmented) source.style.whiteSpace = "pre-wrap"
      const running = removeOrShowNodeTranslation(source, config())
      await vi.waitFor(() => expect(filter).toHaveBeenCalled())
      cleanupNodeTranslations()
      filtering.resolve(false)
      await running
      await settle()
      expect(translate).not.toHaveBeenCalled()
      expect(source.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).toBeNull()
      expect(getPendingBilingualTranslationStates()).toHaveLength(0)
      expect(getPendingVirtualParagraphGroups()).toHaveLength(0)
    },
  )

  it("restores valid translation-only fallback originals at runtime teardown", async () => {
    const source = paragraph("<b>Previous</b> article heading")
    const originalNodes = [...source.childNodes]
    await removeOrShowNodeTranslation(source, config("translationOnly"))
    await settle()
    cleanupNodeTranslations()
    expect([...source.childNodes]).toEqual(originalNodes)
    expect(source.textContent).toBe("Previous article heading")
  })

  it("restores displaced source nodes inside a detached virtualized row", async () => {
    const source = paragraph("<b>Previous</b> article heading")
    const originalNodes = [...source.childNodes]
    await removeOrShowNodeTranslation(source, config("translationOnly"))
    await settle()
    source.remove()
    await settle()
    document.body.append(source)
    expect([...source.childNodes]).toEqual(originalNodes)
    expect(source.textContent).toBe("Previous article heading")
  })

  it("expires mixed inline runs as well as element-backed translations", async () => {
    const source = paragraph("Introductory text.<div>Inner block text.</div>Final source text.")
    const finalText = source.lastChild!
    await removeOrShowNodeTranslation(source, config())
    await settle()
    expect(translate).toHaveBeenCalledTimes(3)
    finalText.textContent = "Fresh final text."
    await settle()
    expect(source.lastChild).toBe(finalText)
    expect(source.querySelectorAll(`.${CONTENT_WRAPPER_CLASS}`)).toHaveLength(2)
  })
})

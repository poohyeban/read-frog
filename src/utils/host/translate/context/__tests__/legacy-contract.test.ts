// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  BLOCK_ATTRIBUTE,
  CONTENT_WRAPPER_CLASS,
  PARAGRAPH_ATTRIBUTE,
} from "@/utils/constants/dom-labels"
import { flushBatchedOperations } from "@/utils/host/dom/batch-dom"
import { captureCommitGate } from "../../commit-gate"
import { translateNodes } from "../../core/translation-modes"
import { removeAllTranslatedWrapperNodes } from "../../dom/translation-cleanup"
import { beginPageTranslationSession, endPageTranslationSession } from "../../translation-session"
import {
  getOrCreateWebPageContext,
  releaseWebPageContext,
  synchronizeWebPageContext,
} from "../../webpage-context"

const translate = vi.hoisted(() => vi.fn<(...args: any[]) => Promise<string>>())
vi.mock("@/utils/host/translate/translate-variants", () => ({ translateTextForPage: translate }))
vi.mock("@/utils/host/translate/filter-small-paragraph", () => ({
  shouldFilterSmallParagraph: async () => false,
}))
vi.mock("@/utils/host/translate/target-language-skip", () => ({
  shouldSkipAsTargetLanguage: async () => false,
}))
vi.mock("defuddle/full", () => ({
  default: class {
    constructor(private readonly source: Document) {}
    parse() {
      return { content: this.source.body.innerHTML }
    }
  },
  createMarkdownContent: (html: string) =>
    new DOMParser().parseFromString(html, "text/html").body.textContent,
}))

// V2's compatibility facade accepts a source descriptor; legacy ignores it.
// This makes the same behavioral tests executable on the untouched baseline.
const scoped = getOrCreateWebPageContext as (
  include: boolean,
  signal?: AbortSignal,
  options?: { source: Node },
) => ReturnType<typeof getOrCreateWebPageContext>
beforeEach(() => {
  document.body.innerHTML =
    '<main><article id="a"><h2>A heading</h2><p>LOCAL_A_SOURCE</p></article><article id="b"><h2>B heading</h2><p>UNRELATED_B_SOURCE</p></article></main>'
  document.title = "Feed title"
  translate.mockReset()
})
afterEach(() => {
  endPageTranslationSession()
  flushBatchedOperations()
  removeAllTranslatedWrapperNodes()
  releaseWebPageContext()
})

it("keeps article contexts separate on the same URL", async () => {
  const a = await scoped(true, undefined, { source: document.querySelector("#a p")! })
  const b = await scoped(true, undefined, { source: document.querySelector("#b p")! })
  expect(a?.webContent).toContain("LOCAL_A_SOURCE")
  expect(a?.webContent).not.toContain("UNRELATED_B_SOURCE")
  expect(b?.webContent).not.toContain("LOCAL_A_SOURCE")
})
it("recognizes generic repeated feed items without article tags or domain rules", async () => {
  document.body.innerHTML =
    '<div role="feed"><div role="listitem"><a rel="bookmark" href="/p/1">First</a><p id="a">LOCAL_A_SOURCE</p></div><div role="listitem"><a rel="bookmark" href="/p/2">Second</a><p>UNRELATED_B_SOURCE</p></div></div>'
  const a = await scoped(true, undefined, { source: document.querySelector("#a")! })
  expect(a?.webContent).toContain("LOCAL_A_SOURCE")
  expect(a?.webContent).not.toContain("UNRELATED_B_SOURCE")
})
it("uses a proven explicit quote dependency without borrowing the adjacent post", async () => {
  document
    .querySelector("main")!
    .insertAdjacentHTML(
      "beforeend",
      '<article id="reply"><blockquote cite="#a">Quoted discussion</blockquote><p id="reply-source">Same ambiguous reply</p></article>',
    )
  const reply = await scoped(true, undefined, { source: document.querySelector("#reply-source")! })
  expect(reply?.webContent).toContain("LOCAL_A_SOURCE")
  expect(reply?.webContent).not.toContain("UNRELATED_B_SOURCE")
})
it("refreshes a recycled post node's context after its own text changes", async () => {
  const source = document.querySelector("#a p")!
  await scoped(true, undefined, { source })
  source.textContent = "RECYCLED_NEW_POST"
  await Promise.resolve()
  const next = await scoped(true, undefined, { source })
  expect(next?.webContent).toContain("RECYCLED_NEW_POST")
  expect(next?.webContent).not.toContain("LOCAL_A_SOURCE")
})
it("keeps moved but semantically unchanged content reusable", async () => {
  const source = document.querySelector("#a p")!
  const first = await scoped(true, undefined, { source })
  document.querySelector("main")!.append(document.querySelector("#a")!)
  await Promise.resolve()
  const second = await scoped(true, undefined, { source })
  expect(second?.webContent).toBe(first?.webContent)
})
it("excludes inputs, scripts and hidden content from context", async () => {
  document
    .querySelector("#a")!
    .insertAdjacentHTML(
      "beforeend",
      '<textarea>PRIVATE_INPUT</textarea><script>PRIVATE_SCRIPT</script><span hidden>PRIVATE_HIDDEN</span><div contenteditable="true">PRIVATE_EDITOR</div>',
    )
  const value = await scoped(true, undefined, { source: document.querySelector("#a p")! })
  expect(value?.webContent).not.toMatch(/PRIVATE_/)
})
it("extracts only within the source shadow root", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const shadow = host.attachShadow({ mode: "open" })
  shadow.innerHTML = "<article><p>SHADOW_SOURCE</p></article>"
  const value = await scoped(true, undefined, { source: shadow.querySelector("p")! })
  expect(value?.webContent).toContain("SHADOW_SOURCE")
  expect(value?.webContent).not.toContain("UNRELATED_B_SOURCE")
})
it("does not let context expiry revoke an unchanged render source", async () => {
  const source = document.querySelector("#a p")!
  const gate = captureCommitGate(
    () => source.isConnected && source.textContent === "LOCAL_A_SOURCE",
  )
  document.querySelector("#b")!.remove()
  synchronizeWebPageContext()
  expect(gate.isCurrent()).toBe(true)
})
it.each(["bilingual", "translationOnly"] as const)(
  "keeps six %s translations during unrelated scope removal",
  async (mode) => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.pageTranslation.mode = mode
    beginPageTranslationSession(config)
    const source = document.querySelector<HTMLElement>("#a p")!
    source.style.whiteSpace = "pre-wrap"
    source.setAttribute(BLOCK_ATTRIBUTE, "")
    source.setAttribute(PARAGRAPH_ATTRIBUTE, "")
    source.textContent = Array.from(
      { length: 6 },
      (_, i) => `Original English paragraph ${i}.`,
    ).join("\n\n")
    const responses: Array<() => void> = []
    translate.mockImplementation(
      (text: string) =>
        new Promise((resolve) => {
          responses.push(() => resolve(text.replace(/Original English paragraph/g, "翻译后的段落")))
        }),
    )
    const pending = translateNodes([source], "legacy-reproduction", false, config)
    await vi.waitFor(() => expect(responses).toHaveLength(6))
    document.querySelector("#b")!.remove()
    synchronizeWebPageContext()
    responses.forEach((finish) => finish())
    await pending
    flushBatchedOperations()
    expect(source.textContent?.match(/翻译后的段落/g)).toHaveLength(6)
    expect(translate).toHaveBeenCalledTimes(6)
  },
)
it("still rejects replaced source nodes", async () => {
  const source = document.querySelector("#a p")!
  const gate = captureCommitGate(
    () => source.isConnected && source.textContent === "LOCAL_A_SOURCE",
  )
  source.replaceWith(source.cloneNode(true))
  expect(gate.isCurrent()).toBe(false)
  expect(document.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).toBeNull()
})

it.each(["bilingual", "translationOnly"] as const)(
  "keeps an independent manual %s request after page Stop",
  async (mode) => {
    const { beginNodeTranslation, cleanupNodeTranslations } =
      await import("../../core/node-translation-lifecycle")
    const config = structuredClone(DEFAULT_CONFIG)
    config.pageTranslation.mode = mode
    beginPageTranslationSession(config)
    const source = document.querySelector<HTMLElement>("#a p")!
    const operation = beginNodeTranslation(source, "manual-test")
    let respond!: () => void
    translate.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = () => resolve("独立操作译文")
        }),
    )
    try {
      const pending = translateNodes([source], "manual-test", false, config)
      await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1))
      endPageTranslationSession()
      respond()
      await pending
      flushBatchedOperations()
      expect(source.textContent).toContain("独立操作译文")
      expect(translate).toHaveBeenCalledTimes(1)
    } finally {
      operation.finish()
      cleanupNodeTranslations()
    }
  },
)
it("rejects an equal-text replacement of the original text node during a request", async () => {
  const config = structuredClone(DEFAULT_CONFIG)
  const source = document.querySelector<HTMLElement>("#a p")!
  let respond!: () => void
  translate.mockImplementation(
    () =>
      new Promise((resolve) => {
        respond = () => resolve("过期译文")
      }),
  )
  const pending = translateNodes([source], "node-replacement", false, config)
  await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1))
  source.firstChild!.replaceWith(document.createTextNode("LOCAL_A_SOURCE"))
  respond()
  await pending
  flushBatchedOperations()
  expect(source.textContent).not.toContain("过期译文")
})

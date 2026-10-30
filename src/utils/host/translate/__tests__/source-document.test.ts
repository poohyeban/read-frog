// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { CONTENT_WRAPPER_CLASS } from "@/utils/constants/dom-labels"
import {
  registerTranslationOnlyAnchorState,
  registerTranslationOnlyOriginals,
  unregisterTranslationOnlyAnchorState,
} from "../core/translation-state"
import { createSourceDocument } from "../source-document"

describe("original-language context projection", () => {
  it("excludes bilingual wrappers and projects guarded in-place text/attributes without changing the page", () => {
    document.body.innerHTML = `<p id="source" title="译后标题">译文<span class="${CONTENT_WRAPPER_CLASS}">Bilingual translation</span></p>`
    const anchor = document.querySelector<HTMLElement>("#source")!
    const node = anchor.firstChild as Text
    registerTranslationOnlyAnchorState({
      anchor,
      attributeAdjustments: [],
      swaps: [
        {
          walkId: "walk",
          runNodes: [node],
          expectedRunText: "译文",
          items: [{ node, originalValue: "Original source", translatedValue: "译文" }],
          attributeItems: [
            {
              element: anchor,
              name: "title",
              originalValue: "Original title",
              translatedValue: "译后标题",
            },
          ],
        },
      ],
    })
    try {
      const snapshot = createSourceDocument()
      expect(snapshot.querySelector("#source")?.textContent).toBe("Original source")
      expect(snapshot.querySelector("#source")?.getAttribute("title")).toBe("Original title")
      expect(anchor.textContent).toBe("译文Bilingual translation")
      // A host edit must supersede the captured original.
      node.data = "New host source"
      expect(createSourceDocument().querySelector("#source")?.textContent).toBe("New host source")
    } finally {
      unregisterTranslationOnlyAnchorState(anchor)
    }
  })
  it("projects displaced translation-only originals without consuming restore records", () => {
    document.body.innerHTML = `<p><span class="${CONTENT_WRAPPER_CLASS}">Translated replacement</span></p>`
    const wrapper = document.querySelector<HTMLElement>(`.${CONTENT_WRAPPER_CLASS}`)!
    registerTranslationOnlyOriginals(wrapper, [document.createTextNode("Displaced original")])
    expect(createSourceDocument().body.textContent).toBe("Displaced original")
    expect(createSourceDocument().body.textContent).toBe("Displaced original")
    expect(document.body.textContent).toBe("Translated replacement")
  })
})

import {
  CONTENT_WRAPPER_CLASS,
  REACT_SHADOW_HOST_CLASS,
  SPINNER_CLASS,
} from "@/utils/constants/dom-labels"
import { getSourceDocumentTitle } from "@/utils/content/document-title"
import {
  getTranslationOnlyAnchorState,
  peekTranslationOnlyOriginals,
} from "./core/translation-state"

/** Detached source projection; an explicit stack also handles deeply nested pages. */
export function createSourceDocument(): Document {
  const snapshot = document.implementation.createHTMLDocument(getSourceDocumentTitle())
  const sourceText = new WeakMap<Node, string>()
  const sourceAttributes = new WeakMap<Element, Map<string, string | null>>()
  const root = document.documentElement.cloneNode(false)
  const stack: { node: Node; parent: Node }[] = []
  const pushChildren = (node: Node, parent: Node) => {
    for (let index = node.childNodes.length - 1; index >= 0; index--)
      stack.push({ node: node.childNodes[index]!, parent })
  }
  pushChildren(document.documentElement, root)
  while (stack.length) {
    const { node, parent } = stack.pop()!
    if (node instanceof HTMLElement) {
      const originals = peekTranslationOnlyOriginals(node)
      if (originals) {
        for (let index = originals.length - 1; index >= 0; index--)
          stack.push({ node: originals[index]!, parent })
        continue
      }
      if (
        [CONTENT_WRAPPER_CLASS, REACT_SHADOW_HOST_CLASS, SPINNER_CLASS].some((cls) =>
          node.classList.contains(cls),
        )
      )
        continue
      for (const record of getTranslationOnlyAnchorState(node)?.swaps ?? []) {
        for (const item of record.items) {
          if (item.node.data === item.translatedValue) sourceText.set(item.node, item.originalValue)
        }
        for (const item of record.attributeItems) {
          if (item.element.getAttribute(item.name) !== item.translatedValue) continue
          const attributes = sourceAttributes.get(item.element) ?? new Map<string, string | null>()
          attributes.set(item.name, item.originalValue)
          sourceAttributes.set(item.element, attributes)
        }
      }
    }
    const copy = node.cloneNode(false)
    const original = sourceText.get(node)
    if (original !== undefined) copy.textContent = original
    if (node instanceof Element && copy instanceof Element) {
      for (const [name, value] of sourceAttributes.get(node) ?? []) {
        if (value === null) copy.removeAttribute(name)
        else copy.setAttribute(name, value)
      }
    }
    parent.appendChild(copy)
    pushChildren(node, copy)
  }
  snapshot.replaceChild(root, snapshot.documentElement)
  snapshot.title = getSourceDocumentTitle()
  return snapshot
}

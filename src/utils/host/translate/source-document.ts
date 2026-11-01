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

export interface SourceProjectionOptions {
  maxCharacters: number
  maxNodes: number
  sanitize?: boolean
}
export interface SourceProjection {
  document: Document
  visitedNodes: number
  sourceCharacters: number
  truncated: boolean
}

/** Shared original-source restoration for full-document compatibility and bounded
 * scoped extraction. It never reads an input value or traverses another frame. */
export function projectSourceRegion(
  source: Element | Document | ShadowRoot,
  options: SourceProjectionOptions,
): SourceProjection {
  const owner =
    source.nodeType === Node.DOCUMENT_NODE ? (source as Document) : source.ownerDocument!
  const snapshot = owner.implementation.createHTMLDocument(getSourceDocumentTitle(owner))
  const sourceText = new WeakMap<Node, string>()
  const sourceAttributes = new WeakMap<Element, Map<string, string | null>>()
  const noteOriginals = (node: HTMLElement) => {
    for (const record of getTranslationOnlyAnchorState(node)?.swaps ?? []) {
      for (const item of record.items)
        if (item.node.data === item.translatedValue) sourceText.set(item.node, item.originalValue)
      for (const item of record.attributeItems) {
        if (item.element.getAttribute(item.name) !== item.translatedValue) continue
        const values = sourceAttributes.get(item.element) ?? new Map<string, string | null>()
        values.set(item.name, item.originalValue)
        sourceAttributes.set(item.element, values)
      }
    }
  }
  // A scoped child may be part of a swap owned by an ancestor anchor.
  let originalAncestorDepth = 0
  for (
    let node = source instanceof Element ? source.parentElement : null;
    node && (!options.sanitize || originalAncestorDepth < 64);
    node = node.parentElement, originalAncestorDepth++
  )
    if (node instanceof HTMLElement) noteOriginals(node)
  const privateSelector =
    'script,style,noscript,template,input,textarea,select,button,iframe,object,embed,[hidden],[aria-hidden="true"],[contenteditable]:not([contenteditable="false"])'
  const isPrivate = (node: Element) => {
    if (node.matches(privateSelector)) return true
    const style = node.isConnected
      ? owner.defaultView?.getComputedStyle(node)
      : (node as HTMLElement).style
    return (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse"
    )
  }
  if (options.sanitize) {
    let ancestor =
      source instanceof Element ? source : source instanceof ShadowRoot ? source.host : null
    let depth = 0
    for (; ancestor && depth < 64; depth++) {
      if (isPrivate(ancestor))
        return { document: snapshot, visitedNodes: 0, sourceCharacters: 0, truncated: false }
      const tree = ancestor.getRootNode()
      ancestor = ancestor.parentElement ?? (tree instanceof ShadowRoot ? tree.host : null)
    }
    // An unbounded ancestor chain cannot prove privacy within the budget.
    if (ancestor)
      return { document: snapshot, visitedNodes: 0, sourceCharacters: 0, truncated: true }
  }
  const fullDocument = source.nodeType === Node.DOCUMENT_NODE
  const root = fullDocument ? owner.documentElement.cloneNode(false) : snapshot.body
  const stack: { node: Node; parent: Node }[] = []
  const pushChildren = (node: Node, parent: Node) => {
    // Bound pending references as well as cloned nodes. Never copy a 50k-child
    // list into the work stack when only the first context window can be used.
    const remaining = Math.max(0, options.maxNodes - visitedNodes - stack.length)
    const limit = Math.min(node.childNodes.length, remaining)
    if (limit < node.childNodes.length) truncated = true
    for (let index = limit - 1; index >= 0; index--)
      stack.push({ node: node.childNodes[index]!, parent })
  }
  let visitedNodes = 0
  let sourceCharacters = 0
  let truncated = false
  if (fullDocument) pushChildren(owner.documentElement, root)
  else if (source instanceof ShadowRoot) pushChildren(source, root)
  else stack.push({ node: source, parent: root })
  while (
    stack.length &&
    visitedNodes < options.maxNodes &&
    sourceCharacters < options.maxCharacters
  ) {
    const { node, parent } = stack.pop()!
    visitedNodes++
    if (options.sanitize && node instanceof Element && isPrivate(node)) continue
    if (node instanceof HTMLElement) {
      const originals = peekTranslationOnlyOriginals(node)
      if (originals) {
        const limit = Math.min(originals.length, options.maxNodes - visitedNodes - stack.length)
        if (limit < originals.length) truncated = true
        for (let index = limit - 1; index >= 0; index--)
          stack.push({ node: originals[index]!, parent })
        continue
      }
      if (
        [CONTENT_WRAPPER_CLASS, REACT_SHADOW_HOST_CLASS, SPINNER_CLASS].some((cls) =>
          node.classList.contains(cls),
        )
      )
        continue
      noteOriginals(node)
    }
    const copy =
      options.sanitize && node instanceof Element
        ? snapshot.createElementNS(node.namespaceURI, node.localName)
        : node.nodeType === Node.TEXT_NODE
          ? snapshot.createTextNode("")
          : node.cloneNode(false)
    if (options.sanitize && node instanceof Element && copy instanceof Element) {
      for (const name of ["id", "class", "href", "title", "alt", "colspan", "rowspan", "lang"])
        if (node.hasAttribute(name)) copy.setAttribute(name, node.getAttribute(name)!.slice(0, 512))
    }
    const original = sourceText.get(node)
    if (node.nodeType === Node.TEXT_NODE) {
      const value = original ?? node.textContent ?? ""
      const remaining = options.maxCharacters - sourceCharacters
      copy.textContent = value.slice(0, remaining)
      sourceCharacters += copy.textContent?.length ?? 0
      if (value.length > remaining) truncated = true
    } else if (original !== undefined) copy.textContent = original
    if (node instanceof Element && copy instanceof Element) {
      for (const [name, value] of sourceAttributes.get(node) ?? []) {
        if (value === null) copy.removeAttribute(name)
        else copy.setAttribute(name, value)
      }
    }
    parent.appendChild(copy)
    pushChildren(node, copy)
  }
  if (stack.length) truncated = true
  if (fullDocument) snapshot.replaceChild(root, snapshot.documentElement)
  snapshot.title = getSourceDocumentTitle(owner)
  return { document: snapshot, visitedNodes, sourceCharacters, truncated }
}

/** Legacy callers still get the same source restoration projection. V2 callers
 * provide a resolved root and explicit finite budgets to projectSourceRegion. */
export function createSourceDocument(): Document {
  return projectSourceRegion(document, { maxCharacters: Infinity, maxNodes: Infinity }).document
}

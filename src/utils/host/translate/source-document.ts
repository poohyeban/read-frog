import {
  CONTENT_WRAPPER_CLASS,
  REACT_SHADOW_HOST_CLASS,
  SPINNER_CLASS,
} from "@/utils/constants/dom-labels"
import { getSourceDocumentTitle } from "@/utils/content/document-title"
import { Sha256Fields } from "@/utils/hash"
import {
  getTranslationOnlyAnchorState,
  peekTranslationOnlyOriginals,
} from "./core/translation-state"

export interface SourceProjectionOptions {
  maxCharacters: number
  maxNodes: number
  sanitize?: boolean
  /** Validation traverses the same bounded original source without cloning DOM. */
  fingerprintOnly?: boolean
}
export interface SourceProjection {
  document: Document | undefined
  visitedNodes: number
  sourceCharacters: number
  truncated: boolean
  fingerprint: string
  styleReads: number
  classes: string[]
  classElements: Element[]
}

/** Shared original-source restoration for full-document compatibility and bounded
 * scoped extraction. It never reads an input value or traverses another frame. */
function readSourceRegion(
  source: Element | Document | ShadowRoot,
  options: SourceProjectionOptions,
): SourceProjection {
  const owner =
    source.nodeType === Node.DOCUMENT_NODE ? (source as Document) : source.ownerDocument!
  const snapshot = options.fingerprintOnly
    ? undefined
    : owner.implementation.createHTMLDocument(getSourceDocumentTitle(owner))
  const fields: string[] = []
  const classes: string[] = []
  const classElements: Element[] = []
  let styleReads = 0
  const eligibility = new WeakMap<Element, boolean>()
  const finish = (visitedNodes: number, sourceCharacters: number, truncated: boolean) => ({
    document: snapshot,
    visitedNodes,
    sourceCharacters,
    truncated,
    styleReads,
    classes,
    classElements,
    fingerprint: options.sanitize ? Sha256Fields(...fields, String(truncated)) : "",
  })
  // An explicitly supplied node never grants access to another browsing context.
  if (options.sanitize && owner.defaultView && owner.defaultView !== window)
    return finish(0, 0, false)
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
    'script,style,noscript,template,input,textarea,select,button,iframe,object,embed,[hidden],[inert],[aria-hidden="true"],[contenteditable]:not([contenteditable="false"])'
  const isPrivate = (node: Element) => {
    const cached = eligibility.get(node)
    if (cached !== undefined) return cached
    if (
      node.matches(privateSelector) ||
      node.classList.contains(REACT_SHADOW_HOST_CLASS) ||
      node.classList.contains(SPINNER_CLASS) ||
      (node.classList.contains(CONTENT_WRAPPER_CLASS) &&
        !(node instanceof HTMLElement && peekTranslationOnlyOriginals(node)))
    ) {
      eligibility.set(node, true)
      return true
    }
    styleReads++
    const style = node.isConnected
      ? owner.defaultView?.getComputedStyle(node)
      : (node as HTMLElement).style
    const blocked =
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse" ||
      style?.opacity === "0" ||
      style?.contentVisibility === "hidden"
    eligibility.set(node, blocked)
    return blocked
  }
  if (options.sanitize) {
    let ancestor =
      source instanceof Element ? source : source instanceof ShadowRoot ? source.host : null
    let depth = 0
    for (; ancestor && depth < 64; depth++) {
      if (isPrivate(ancestor)) return finish(0, 0, false)
      const tree = ancestor.getRootNode()
      ancestor = ancestor.parentElement ?? (tree instanceof ShadowRoot ? tree.host : null)
    }
    // An unbounded ancestor chain cannot prove privacy within the budget.
    if (ancestor) return finish(0, 0, true)
  }
  const fullDocument = source.nodeType === Node.DOCUMENT_NODE
  const root = fullDocument
    ? snapshot
      ? owner.documentElement.cloneNode(false)
      : undefined
    : snapshot?.body
  const stack: { node: Node; parent: Node | undefined; depth: number }[] = []
  const pushChildren = (node: Node, parent: Node | undefined, depth: number) => {
    // Bound pending references as well as cloned nodes. Never copy a 50k-child
    // list into the work stack when only the first context window can be used.
    const remaining = Math.max(0, options.maxNodes - visitedNodes - stack.length)
    const limit = Math.min(node.childNodes.length, remaining)
    if (limit < node.childNodes.length) truncated = true
    for (let index = limit - 1; index >= 0; index--)
      stack.push({ node: node.childNodes[index]!, parent, depth })
  }
  let visitedNodes = 0
  let sourceCharacters = 0
  let truncated = false
  if (fullDocument) pushChildren(owner.documentElement, root, 0)
  else if (source instanceof ShadowRoot) pushChildren(source, root, 0)
  else stack.push({ node: source, parent: root, depth: 0 })
  while (
    stack.length &&
    visitedNodes < options.maxNodes &&
    sourceCharacters < options.maxCharacters
  ) {
    const { node, parent, depth } = stack.pop()!
    visitedNodes++
    if (options.sanitize && node instanceof Element && isPrivate(node)) continue
    if (node instanceof HTMLElement) {
      const originals = peekTranslationOnlyOriginals(node)
      if (originals) {
        const limit = Math.min(originals.length, options.maxNodes - visitedNodes - stack.length)
        if (limit < originals.length) truncated = true
        for (let index = limit - 1; index >= 0; index--)
          stack.push({ node: originals[index]!, parent, depth })
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
    if (options.sanitize && node.nodeType === Node.COMMENT_NODE) continue
    const copy = snapshot
      ? options.sanitize && node instanceof Element
        ? snapshot.createElementNS(node.namespaceURI, node.localName)
        : node.nodeType === Node.TEXT_NODE
          ? snapshot.createTextNode("")
          : node.cloneNode(false)
      : undefined
    if (options.sanitize) fields.push(String(depth), String(node.nodeType))
    if (node instanceof Element) {
      if (options.sanitize) fields.push(node.namespaceURI ?? "", node.localName)
      classes.push(
        (sourceAttributes.get(node)?.get("class") ?? node.getAttribute("class") ?? "").slice(
          0,
          512,
        ),
      )
      if (copy instanceof Element) classElements.push(copy)
      for (const name of ["id", "class", "href", "title", "alt", "colspan", "rowspan", "lang"]) {
        const original = sourceAttributes.get(node)
        const value = original?.has(name) ? original.get(name) : node.getAttribute(name)
        if (value !== null && value !== undefined) {
          const bounded = value.slice(0, 512)
          if (options.sanitize && copy instanceof Element) copy.setAttribute(name, bounded)
          if (options.sanitize && name !== "class") fields.push(name, bounded)
        }
      }
    }
    const original = sourceText.get(node)
    if (node.nodeType === Node.TEXT_NODE) {
      const value = original ?? node.textContent ?? ""
      const remaining = options.maxCharacters - sourceCharacters
      const text = value.slice(0, remaining)
      if (copy) copy.textContent = text
      if (options.sanitize) fields.push(text)
      sourceCharacters += text.length
      if (value.length > remaining) truncated = true
    } else if (original !== undefined) {
      if (copy) copy.textContent = original
      fields.push(original)
    }
    if (!options.sanitize && node instanceof Element && copy instanceof Element)
      for (const [name, value] of sourceAttributes.get(node) ?? []) {
        if (value === null) copy.removeAttribute(name)
        else copy.setAttribute(name, value)
      }
    if (copy) parent?.appendChild(copy)
    pushChildren(node, copy, depth + 1)
  }
  if (stack.length) truncated = true
  if (snapshot) {
    if (fullDocument && root) snapshot.replaceChild(root, snapshot.documentElement)
    snapshot.title = getSourceDocumentTitle(owner)
  }
  return finish(visitedNodes, sourceCharacters, truncated)
}

export function projectSourceRegion(
  source: Element | Document | ShadowRoot,
  options: SourceProjectionOptions,
) {
  const result = readSourceRegion(source, { ...options, fingerprintOnly: false })
  return { ...result, document: result.document! }
}
export function inspectSourceRegion(
  source: Element | Document | ShadowRoot,
  options: SourceProjectionOptions,
) {
  return readSourceRegion(source, { ...options, fingerprintOnly: true })
}

/** Legacy callers still get the same source restoration projection. V2 callers
 * provide a resolved root and explicit finite budgets to projectSourceRegion. */
export function createSourceDocument(): Document {
  return projectSourceRegion(document, { maxCharacters: Infinity, maxNodes: Infinity }).document
}

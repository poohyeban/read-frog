import type { ContextScope, ContextSource, ContextScopeType } from "./types"
import { Sha256Fields } from "@/utils/hash"

const rootIds = new WeakMap<Node, string>()
const knownCollectionItems = new WeakSet<Element>()
const SEMANTIC_ITEM =
  'article, [role="article"], [itemtype*="SocialMediaPosting"], [itemtype*="DiscussionForumPosting"], [itemtype*="Comment"]'
const FEED = '[role="feed"], [itemtype*="ItemList"]'
const LINK = 'a[rel~="bookmark"], a[itemprop="url"]'
const MAX_ANCESTORS = 64
const MAX_PROBES = 96
export function scopeRootIdentity(root: Node): string {
  let id = rootIds.get(root)
  if (!id) {
    id = crypto.randomUUID()
    rootIds.set(root, id)
  }
  return id
}
/** A bounded subtree probe; nested unrelated articles are opaque. */
export function findScopeElement(root: Element, selector: string): Element | undefined {
  if (root.matches(selector)) return root
  let node = root.firstElementChild
  for (let probes = 0; node && probes < MAX_PROBES; probes++) {
    const opaque = node.matches(SEMANTIC_ITEM)
    if (!opaque && node.matches(selector)) return node
    if (!opaque && node.firstElementChild) {
      node = node.firstElementChild
      continue
    }
    while (node && node !== root && !node.nextElementSibling) node = node.parentElement
    node = node && node !== root ? node.nextElementSibling : null
  }
  return undefined
}
export function scopeLocator(root: Element | Document | ShadowRoot | null): string {
  if (!root || root.nodeType !== Node.ELEMENT_NODE) return ""
  const element = root as Element
  const link = findScopeElement(element, LINK)
  return element.getAttribute("itemid") ?? link?.getAttribute("href") ?? element.id
}
function repeated(element: Element): boolean {
  let count = 0
  for (
    let sibling = element.parentElement?.firstElementChild, i = 0;
    sibling && i < 12;
    sibling = sibling.nextElementSibling, i++
  ) {
    if (
      sibling.localName === element.localName &&
      sibling.getAttribute("role") === element.getAttribute("role")
    )
      count++
    if (count >= 2) return true
  }
  return false
}
function relations(root: Element): Element[] {
  const dependencies = new Set<Element>()
  const referenceRoot = root.getRootNode()
  if (!(referenceRoot instanceof Document || referenceRoot instanceof ShadowRoot)) return []
  // Only an explicit same-document quote or rel=up link proves a relationship.
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  for (
    let i = 0, node: Node | null = root;
    node && i < MAX_PROBES && dependencies.size < 4;
    i++, node = walker.nextNode()
  ) {
    const element = node as Element
    const raw = element.matches("blockquote[cite]")
      ? element.getAttribute("cite")
      : element.matches('a[rel~="up"]')
        ? element.getAttribute("href")
        : null
    if (!raw) continue
    try {
      const url = new URL(raw, root.ownerDocument.URL)
      const current = new URL(root.ownerDocument.URL)
      if (
        url.origin !== current.origin ||
        url.pathname !== current.pathname ||
        url.search !== current.search ||
        !url.hash
      )
        continue
      const target = referenceRoot.getElementById(decodeURIComponent(url.hash.slice(1)))
      if (target && target !== root && !target.contains(root) && !root.contains(target))
        dependencies.add(target)
    } catch {
      /* An unresolvable reference grants no additional context. */
    }
  }
  return [...dependencies]
}
export function resolveContextScope(input: ContextSource = {}): ContextScope {
  const doc = input.document ?? input.source?.ownerDocument ?? document
  if (input.source && input.source.ownerDocument !== doc && input.source !== doc)
    throw new Error("Context source belongs to another document")
  const initial =
    input.source?.nodeType === Node.ELEMENT_NODE
      ? (input.source as Element)
      : input.source?.parentElement
  let root: ContextScope["root"] =
    initial ?? (input.source instanceof ShadowRoot ? input.source : null)
  let type: ContextScopeType = input.kind === "selection" ? "Selection" : "Independent"
  let confidence: ContextScope["confidence"] = "local"
  let collection = false
  if (
    input.kind === "document" ||
    input.source?.nodeType === Node.DOCUMENT_NODE ||
    (!input.source && input.kind !== "independent" && input.kind !== "selection")
  ) {
    root = doc
    type = "Document"
    confidence = "semantic"
  } else if (input.kind !== "independent") {
    let section: Element | undefined
    for (
      let node = initial, depth = 0;
      node && depth < MAX_ANCESTORS;
      node = node.parentElement, depth++
    ) {
      if (node.matches(SEMANTIC_ITEM)) {
        root = node
        collection =
          knownCollectionItems.has(node) ||
          node.parentElement?.matches(FEED) === true ||
          repeated(node)
        if (collection) knownCollectionItems.add(node)
        type = node.parentElement?.matches(FEED) ? "FeedItem" : "Article"
        confidence = "semantic"
        break
      }
      if (
        node.parentElement?.matches(FEED) ||
        (node.matches('[role="listitem"], li') && repeated(node)) ||
        (repeated(node) && findScopeElement(node, LINK))
      ) {
        root = node
        type = "FeedItem"
        collection = true
        confidence = "structural"
        break
      }
      if (
        !section &&
        node.matches('section, [role="region"]') &&
        (node.hasAttribute("aria-label") || findScopeElement(node, "h1,h2,h3,h4,h5,h6"))
      )
        section = node
      if (node.matches('main, [role="main"], body')) {
        if (section) {
          root = section
          type = "Section"
          confidence = "semantic"
        }
        // An unlabeled main may contain many posts; never infer one article.
        break
      }
    }
  }
  const dependencies = root instanceof Element ? relations(root) : []
  if (dependencies.length) type = "Thread"
  return Object.freeze({
    id: root ? scopeRootIdentity(root) : `independent:${Sha256Fields(input.text ?? "")}`,
    type,
    root,
    document: doc,
    dependencies: Object.freeze(dependencies),
    locator: scopeLocator(root),
    confidence,
    collection,
    sourceText: input.text,
  })
}

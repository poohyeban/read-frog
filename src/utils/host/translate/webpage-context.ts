import type { WebPageContext } from "@/types/content"
import {
  CONTENT_WRAPPER_CLASS,
  REACT_SHADOW_HOST_CLASS,
  SPINNER_CLASS,
} from "@/utils/constants/dom-labels"
import { getSourceDocumentTitle } from "@/utils/content/document-title"
import { getDocumentDescription } from "@/utils/content/metadata"
import { logger } from "@/utils/logger"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { ContextCoordinator } from "./context-coordinator"
import { wasNodeRemovedByExtension } from "./core/translation-state"
import { ResourceScope } from "./resource-scope"
import { createSourceDocument } from "./source-document"
import { truncateWebPageContent, WEB_PAGE_CONTENT_CHAR_LIMIT } from "./webpage-content"

export interface CachedWebPageContext extends WebPageContext {
  url: string
  webContent: string
}

let cachedWebPageContext: CachedWebPageContext | null = null
const extraction = new ContextCoordinator<string>(2, 1000)
let contentRevision = 0
let revisionController = new AbortController()
let lastInvalidatedAt = 0
let cachedAt = 0
let documentScope: ResourceScope | undefined
let documentObserver: MutationObserver | undefined

export function getDocumentContextSignal(): AbortSignal {
  if (!documentScope || documentScope.signal.aborted) {
    documentScope = new ResourceScope()
    if (typeof document !== "undefined") {
      documentObserver = new MutationObserver(notePageContentMutations)
      documentObserver.observe(document.documentElement, { childList: true, subtree: true })
      const observer = documentObserver
      documentScope.own(() => observer.disconnect())
      window.addEventListener("pagehide", releaseWebPageContext, { once: true })
      documentScope.own(() => window.removeEventListener("pagehide", releaseWebPageContext))
    }
  }
  return documentScope.signal
}

export class ContextUnstableError extends Error {
  readonly code = "CONTEXT_UNSTABLE"
  readonly retryAfterMs = 1000
  constructor() {
    super("Page content keeps changing; retry translation once the article settles")
    this.name = "ContextUnstableError"
  }
}

/** A finite quiet window, used only after an actual document replacement. */
export function waitForStableWebPageContext(signal?: AbortSignal, maxWaitMs = 1500): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const clean = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
    const abort = () => {
      clean()
      reject(new TranslationCancelledError())
    }
    const check = () => {
      if (signal?.aborted) return abort()
      const quiet = Date.now() - lastInvalidatedAt
      if (quiet >= 100) {
        clean()
        resolve()
        return
      }
      if (Date.now() - started >= maxWaitMs) {
        clean()
        reject(new ContextUnstableError())
        return
      }
      timer = setTimeout(check, Math.min(100 - quiet, maxWaitMs - (Date.now() - started)))
    }
    signal?.addEventListener("abort", abort, { once: true })
    check()
  })
}
let contextUrl: string | undefined
const revisions = new WeakMap<CachedWebPageContext, number>()
const contextSignals = new WeakMap<CachedWebPageContext, AbortSignal>()
export function getWebPageContextSignal(context: CachedWebPageContext): AbortSignal | undefined {
  return contextSignals.get(context)
}

export function getWebPageContentRevision(): number {
  return contentRevision
}

export function invalidateWebPageContext(): void {
  contentRevision++
  lastInvalidatedAt = Date.now()
  revisionController.abort(new TranslationCancelledError())
  revisionController = new AbortController()
  cachedWebPageContext = null
  extraction.clear()
}

export function releaseWebPageContext(): void {
  documentScope?.dispose()
  documentScope = undefined
  documentObserver = undefined
  invalidateWebPageContext()
  contextUrl = undefined
}

export function isWebPageContextCurrent(context: CachedWebPageContext): boolean {
  return (
    revisions.get(context) === contentRevision &&
    (context.url === window.location.href ||
      isInPageAnchorChange(context.url, window.location.href))
  )
}

const ARTICLE_ROOT = "main, article, [role=main]"
const UTILITY_SELECTOR = `.${CONTENT_WRAPPER_CLASS}, .${REACT_SHADOW_HOST_CLASS}, .${SPINNER_CLASS}`
function isSourceNode(node: Node): boolean {
  if (wasNodeRemovedByExtension(node)) return false
  if (node instanceof Element) return !node.matches(UTILITY_SELECTOR)
  return node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim()
}

/** Appending comments/feeds and editing paragraphs change regions, not the article. */
export function notePageContentMutations(records: readonly MutationRecord[]): void {
  for (const record of records) {
    if (record.type !== "childList") continue
    const target = record.target instanceof Element ? record.target : record.target.parentElement
    if (!target || target.closest(`head, ${UTILITY_SELECTOR}`)) continue
    const removed = [...record.removedNodes].filter(isSourceNode)
    if (!removed.length) continue
    const replacesRoot = removed.some(
      (node) =>
        node instanceof Element &&
        (node.matches(`body, ${ARTICLE_ROOT}`) || !!node.querySelector(ARTICLE_ROOT)),
    )
    const replacesContents =
      target.matches(`body, ${ARTICLE_ROOT}`) &&
      removed.length >= [...target.childNodes].filter(isSourceNode).length
    if (replacesRoot || replacesContents) {
      invalidateWebPageContext()
      return
    }
  }
}

function keepLeadingText(node: Node, budget: number) {
  let remaining = budget
  for (const child of Array.from(node.childNodes)) {
    if (remaining <= 0) {
      child.remove()
      continue
    }
    const length = (child.textContent ?? "").replace(/\s+/g, " ").length
    if (length > remaining) {
      keepLeadingText(child, remaining)
    }
    remaining -= length
  }
}

function flattenNestedTables(root: Element) {
  for (const table of Array.from(root.querySelectorAll<HTMLTableElement>("table table"))) {
    const block = table.ownerDocument.createElement("div")
    if (table.caption) {
      block.append(...table.caption.childNodes)
    }
    for (const row of Array.from(table.rows)) {
      for (const cell of Array.from(row.cells)) {
        const cellBlock = table.ownerDocument.createElement("div")
        cellBlock.append(...cell.childNodes)
        block.append(cellBlock)
      }
    }
    table.replaceWith(block)
  }
}

function prepareMarkdownSource(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  keepLeadingText(doc.body, WEB_PAGE_CONTENT_CHAR_LIMIT)
  flattenNestedTables(doc.body)
  return doc.body.innerHTML
}

async function extractWebpageContent(signal: AbortSignal): Promise<string> {
  let snapshotDoc: Document | undefined
  try {
    const { default: Defuddle, createMarkdownContent } = await import("defuddle/full")
    signal.throwIfAborted()
    snapshotDoc = createSourceDocument()
    const result = new Defuddle(snapshotDoc, {
      url: window.location.href,
      useAsync: false,
    }).parse()

    if (result.content) {
      return createMarkdownContent(prepareMarkdownSource(result.content), window.location.href)
    }
  } catch {
    logger.warn("Defuddle parsing failed, falling back to body text:")
  }
  signal.throwIfAborted()
  return (snapshotDoc ?? createSourceDocument()).body?.textContent || ""
}

function splitUrlFragment(url: string): [base: string, fragment: string] {
  const index = url.indexOf("#")
  return index === -1 ? [url, ""] : [url.slice(0, index), url.slice(index + 1)]
}

/**
 * Whether a fragment points into the current document rather than naming an
 * app route: empty, "top", or the id of an element (or name of an `<a>`) on the
 * page — how HTML finds the "indicated part of the document".
 */
function isInPageFragment(fragment: string): boolean {
  if (fragment === "" || fragment.toLowerCase() === "top") {
    return true
  }

  const candidates = [fragment]
  try {
    candidates.push(decodeURIComponent(fragment))
  } catch {
    // A malformed escape cannot name an element; the raw form is still tried.
  }
  return candidates.some(
    (candidate) =>
      document.getElementById(candidate) !== null ||
      Array.from(document.getElementsByName(candidate)).some(
        (element) => element.localName === "a",
      ),
  )
}

/**
 * An in-page anchor jump (a table of contents, a footnote, scroll-spy) stays on
 * the same document, so it keeps the context. Rebuilding would re-parse the
 * whole page, read back the translations already inserted into it as page
 * content, and so re-key the summary and every later paragraph's cache entry.
 * Hash routes (`#/settings`, `#inbox/…`) name no element and still rebuild.
 */
export function isInPageAnchorChange(cachedUrl: string, currentUrl: string): boolean {
  const [cachedBase, cachedFragment] = splitUrlFragment(cachedUrl)
  const [currentBase, currentFragment] = splitUrlFragment(currentUrl)
  return (
    cachedBase === currentBase &&
    isInPageFragment(cachedFragment) &&
    isInPageFragment(currentFragment)
  )
}

export async function getOrCreateWebPageContext(
  includeContent = true,
  signal?: AbortSignal,
): Promise<CachedWebPageContext | null> {
  if (typeof window === "undefined" || typeof document === "undefined") return null

  getDocumentContextSignal()
  // Drain synchronously so a request in the mutation's own JS turn cannot see
  // a cached old article before MutationObserver delivery.
  if (documentObserver) notePageContentMutations(documentObserver.takeRecords())
  const currentUrl = window.location.href
  signal?.throwIfAborted()
  if (contextUrl && contextUrl !== currentUrl && !isInPageAnchorChange(contextUrl, currentUrl))
    invalidateWebPageContext()
  contextUrl = currentUrl
  if (cachedWebPageContext && Date.now() - cachedAt > 5 * 60_000) invalidateWebPageContext()
  const revision = contentRevision
  if (!includeContent) {
    const metadata = {
      url: currentUrl,
      webTitle: getSourceDocumentTitle(),
      webDescription: getDocumentDescription(document),
      webContent: "",
    }
    contextSignals.set(metadata, revisionController.signal)
    revisions.set(metadata, revision)
    return metadata
  }
  if (cachedWebPageContext?.url === currentUrl) {
    return cachedWebPageContext
  }
  if (cachedWebPageContext && isInPageAnchorChange(cachedWebPageContext.url, currentUrl)) {
    cachedWebPageContext = { ...cachedWebPageContext, url: currentUrl }
    contextSignals.set(cachedWebPageContext, revisionController.signal)
    revisions.set(cachedWebPageContext, revision)
    return cachedWebPageContext
  }

  const context = {
    url: currentUrl,
    webTitle: getSourceDocumentTitle(),
    webDescription: getDocumentDescription(document),
    webContent: await extraction.get(
      String(revision),
      async (taskSignal) => truncateWebPageContent(await extractWebpageContent(taskSignal)),
      signal,
    ),
  }
  if (revision !== contentRevision) throw new TranslationCancelledError()
  contextSignals.set(context, revisionController.signal)
  revisions.set(context, revision)
  cachedWebPageContext = context
  cachedAt = Date.now()
  return context
}

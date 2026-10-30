import type { WebPageContext } from "@/types/content"
import { getSourceDocumentTitle } from "@/utils/content/document-title"
import { getDocumentDescription } from "@/utils/content/metadata"
import { logger } from "@/utils/logger"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { ContextCoordinator } from "./context-coordinator"
import { createSourceDocument } from "./source-document"
import { truncateWebPageContent, WEB_PAGE_CONTENT_CHAR_LIMIT } from "./webpage-content"

export interface CachedWebPageContext extends WebPageContext {
  url: string
  webContent: string
}

let cachedWebPageContext: CachedWebPageContext | null = null
const extraction = new ContextCoordinator<string>(2, 1000)
let contentRevision = 0
let contextUrl: string | undefined
const revisions = new WeakMap<CachedWebPageContext, number>()

export function getWebPageContentRevision(): number {
  return contentRevision
}

export function invalidateWebPageContext(): void {
  contentRevision++
  cachedWebPageContext = null
  extraction.clear()
}

export function releaseWebPageContext(): void {
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

/** Coalesce substantive article replacement separately from paragraph revisions. */
export function notePageContentMutations(records: readonly MutationRecord[]): void {
  const roots = new Set<Node>()
  for (const record of records) {
    const target = record.target instanceof Element ? record.target : record.target.parentElement
    if (!target || target.closest("head")) continue
    if (
      record.type === "childList" &&
      (target.matches("body, main, article, [role=main]") ||
        [...record.addedNodes, ...record.removedNodes].some(
          (node) => node instanceof Element && node.matches("body, main, article, [role=main]"),
        ))
    ) {
      roots.add(target)
    }
  }
  if (roots.size) invalidateWebPageContext()
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

  const currentUrl = window.location.href
  signal?.throwIfAborted()
  if (contextUrl && contextUrl !== currentUrl && !isInPageAnchorChange(contextUrl, currentUrl))
    invalidateWebPageContext()
  contextUrl = currentUrl
  const revision = contentRevision
  if (!includeContent) {
    const metadata = {
      url: currentUrl,
      webTitle: getSourceDocumentTitle(),
      webDescription: getDocumentDescription(document),
      webContent: "",
    }
    revisions.set(metadata, revision)
    return metadata
  }
  if (cachedWebPageContext?.url === currentUrl) {
    return cachedWebPageContext
  }
  if (cachedWebPageContext && isInPageAnchorChange(cachedWebPageContext.url, currentUrl)) {
    cachedWebPageContext = { ...cachedWebPageContext, url: currentUrl }
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
  revisions.set(context, revision)
  cachedWebPageContext = context
  return context
}

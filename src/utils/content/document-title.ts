declare global {
  interface Window {
    __READ_FROG_TRANSLATED_DOCUMENT_TITLE__?: { source: string; translated: string }
  }
}

/**
 * The title the page itself set, even while the tab shows page translation's
 * translated title.
 *
 * Every prompt that cites the page title must use this, never `document.title`:
 * the prompt is part of the translation cache key, and `document.title` is the
 * source or the translation depending on whether the title request has landed
 * yet. Reading it directly made the same paragraph hash differently from one
 * visit to the next, and re-translate.
 */
export function getSourceDocumentTitle(): string {
  const currentTitle = document.title || ""
  const applied =
    typeof window === "undefined" ? undefined : window.__READ_FROG_TRANSLATED_DOCUMENT_TITLE__
  // Compared rather than trusted: once the page sets a title of its own, that
  // title is the source again.
  return applied?.translated === currentTitle ? applied.source : currentTitle
}

export function setAppliedDocumentTitleTranslation(source: string, translated: string): void {
  window.__READ_FROG_TRANSLATED_DOCUMENT_TITLE__ = { source, translated }
}

export function clearAppliedDocumentTitleTranslation(): void {
  delete window.__READ_FROG_TRANSLATED_DOCUMENT_TITLE__
}

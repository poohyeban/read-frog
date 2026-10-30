import {
  clearAppliedDocumentTitleTranslation,
  setAppliedDocumentTitleTranslation,
} from "@/utils/content/document-title"
import { captureCommitGate } from "@/utils/host/translate/commit-gate"
import { translateTextForPageTitle } from "@/utils/host/translate/translate-variants"
import { getOrCreateWebPageContext } from "@/utils/host/translate/webpage-context"
import { logger } from "@/utils/logger"
import { isTranslationCancelledError } from "@/utils/request/cancellation"

/** Title source, observer, request epoch and restore record share one owner. */
export class DocumentTitleTask {
  private request: AbortController | undefined
  private titleObserver: MutationObserver | null = null
  // Non-null exactly while the tab title is being tracked.
  private lastSourceTitle: string | null = null
  private lastAppliedTranslatedTitle: string | null = null
  // Never reset: a request from before a stop or a switch-off must not match
  // a later one's version.
  private titleRequestVersion = 0
  constructor(private readonly isActive: () => boolean) {}
  invalidate(): void {
    this.request?.abort()
    this.request = undefined
    this.titleRequestVersion++
  }

  private shouldManageDocumentTitle(): boolean {
    return window === window.top
  }

  async prime(shouldPrimeWebPageContext: boolean): Promise<void> {
    if (!this.shouldManageDocumentTitle() || !shouldPrimeWebPageContext) {
      return
    }

    try {
      await getOrCreateWebPageContext(false)
    } catch {
      logger.warn("Failed to prime webpage context before translating document title:")
    }
  }

  start(): void {
    if (!this.shouldManageDocumentTitle() || this.lastSourceTitle !== null) {
      return
    }

    this.lastSourceTitle = document.title || ""
    this.lastAppliedTranslatedTitle = null

    this.observeDocumentTitle()
    void this.syncDocumentTitle(this.lastSourceTitle)
  }

  dispose(): void {
    if (!this.shouldManageDocumentTitle() || this.lastSourceTitle === null) {
      return
    }

    const currentTitle = document.title || ""
    if (currentTitle !== this.lastAppliedTranslatedTitle) {
      this.lastSourceTitle = currentTitle
    }

    if (this.titleObserver) {
      this.titleObserver.disconnect()
      this.titleObserver = null
    }

    this.invalidate()

    if (this.lastSourceTitle !== null && document.title !== this.lastSourceTitle) {
      document.title = this.lastSourceTitle
    }
    clearAppliedDocumentTitleTranslation()

    this.lastSourceTitle = null
    this.lastAppliedTranslatedTitle = null
  }

  private observeDocumentTitle(): void {
    if (!document.head) {
      return
    }

    if (this.titleObserver) {
      this.titleObserver.disconnect()
    }

    this.titleObserver = new MutationObserver(() => {
      this.handleDocumentTitleMutation()
    })

    this.titleObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  }

  private handleDocumentTitleMutation(): void {
    if (!this.isActive() || !this.shouldManageDocumentTitle()) {
      return
    }

    const currentTitle = document.title || ""

    if (currentTitle === this.lastSourceTitle) {
      return
    }

    if (currentTitle === this.lastAppliedTranslatedTitle) {
      return
    }

    this.lastSourceTitle = currentTitle
    void this.syncDocumentTitle(currentTitle)
  }

  private async syncDocumentTitle(sourceTitle: string): Promise<void> {
    if (!sourceTitle.trim() || !this.isActive() || !this.shouldManageDocumentTitle()) {
      return
    }

    this.request?.abort()
    const request = new AbortController()
    this.request = request
    const gate = captureCommitGate(() => this.isActive())
    const requestVersion = ++this.titleRequestVersion

    try {
      const translatedTitle = await translateTextForPageTitle(sourceTitle, request.signal)
      if (!gate.isCurrent() || requestVersion !== this.titleRequestVersion) {
        return
      }

      const nextTitle = translatedTitle || sourceTitle
      this.lastAppliedTranslatedTitle = nextTitle
      // Before the write, so no prompt can see the translation without it.
      setAppliedDocumentTitleTranslation(sourceTitle, nextTitle)

      if (document.title === nextTitle) {
        return
      }

      document.title = nextTitle
    } catch (error) {
      // A cancelled session's title request rejecting is expected, not noise.
      if (isTranslationCancelledError(error)) return
      if (requestVersion === this.titleRequestVersion) {
        logger.warn("Failed to translate document title:")
      }
    }
  }
}

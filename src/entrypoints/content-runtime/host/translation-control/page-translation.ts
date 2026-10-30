import type { Config } from "@/types/config/config"
import type { LangCodeISO6393 } from "@/utils/languages"
import debounce from "debounce"
import { getLocalConfig } from "@/utils/config/storage"
import {
  CONTENT_WRAPPER_CLASS,
  REACT_SHADOW_HOST_CLASS,
  SPINNER_CLASS,
} from "@/utils/constants/dom-labels"
import {
  GIANT_PARAGRAPH_MAX_SPLIT_DEPTH,
  GIANT_SPLIT_STRANDED_TEXT_MAX_UNITS,
} from "@/utils/constants/translate"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import {
  hasNoWalkAncestor,
  isHTMLElement,
  isWalkBlockedElement as isWalkBlockedElementFilter,
} from "@/utils/host/dom/filter"
import { isLatexmlTextBoxReflowRecord } from "@/utils/host/dom/latexml-text-box"
import {
  canSplitGiantWithoutStrandingOwnText,
  walkAndLabelElement,
  walkAndLabelElementChunked,
} from "@/utils/host/dom/traversal"
import { carryTranslationsAcrossRewrite } from "@/utils/host/translate/core/translation-carry"
import {
  findEnclosingBilingualLayoutSource,
  findStaleBilingualLayoutSource,
  findStaleTranslationOnlyAnchor,
  getBilingualTranslationStateForWrapper,
  wasCharacterDataChangeExtensionDriven,
  wasNodeRemovedByExtension,
} from "@/utils/host/translate/core/translation-state"
import { canSplitParagraphIntoDescendants } from "@/utils/host/translate/dom/paragraph-segmentation"
import { pageLocalScheduler } from "@/utils/host/translate/local-scheduler"
import {
  removeAllTranslatedWrapperNodes,
  translateNodes,
  translateNodesBilingualMode,
  translateWalkedElement,
} from "@/utils/host/translate/node-manipulation"
import { primePageTranslationContext } from "@/utils/host/translate/translate-variants"
import {
  beginPageTranslationSession,
  getPageTranslationSession,
  getPageTranslationSessionVersion,
  replacePageTranslationSession,
  type PageSession,
  endPageTranslationSession,
} from "@/utils/host/translate/translation-session"
import { cleanupNodeSiteRuleCSSIfUnused } from "@/utils/host/translate/ui/node-site-rule-css"
import { cancelSpinnerAnimation } from "@/utils/host/translate/ui/spinner"
import { ensureSiteRuleCSS, removeSiteRuleCSS } from "@/utils/host/translate/ui/style-injector"
import { validateTranslationConfigAndToast } from "@/utils/host/translate/ui/translation-config-feedback"
import {
  getWebPageContentRevision,
  isInPageAnchorChange,
  releaseWebPageContext,
} from "@/utils/host/translate/webpage-context"
import { logger } from "@/utils/logger"
import { sendMessage } from "@/utils/message"
import {
  canResolvedProviderRefGenerateText,
  resolvePageTranslationProvider,
  resolvePageTranslationProviderOrNull,
} from "@/utils/providers/provider-ref"
import { removeReactShadowHost } from "@/utils/react-shadow-host/create-shadow-host"
import { getEffectiveSiteRule } from "@/utils/site-rules/effective"
import { DocumentTitleTask } from "./document-title-task"
import { DOMObservation } from "./dom-observation"
import { ViewportScheduler, renderedHeight, maxUnitHeight } from "./viewport-scheduler"

type SimpleIntersectionOptions = Omit<IntersectionObserverInit, "threshold"> & {
  threshold?: number
}

type DebouncedRetry = (() => void) & { clear: () => void }

interface RetranslationBudget {
  windowStart: number
  passes: number
}

interface IPageTranslationManager {
  /**
   * Indicates whether the page translation is currently active
   */
  readonly isActive: boolean

  /**
   * Starts the automatic page translation functionality
   * Registers observers, touch triggers and set storage
   */
  start: () => Promise<void>

  /**
   * Stops the automatic page translation functionality
   * Cleans up all observers and removes translated content and set storage.
   * Pass `userInitiated` when the stop comes from a user surface (shortcut,
   * touch gesture, popup/floating-button toggle) so the background records
   * the refusal and auto-translation stops re-enabling the page (#2011).
   */
  stop: (options?: { userInitiated?: boolean }) => void

  /**
   * Re-resolves the site rule for the current URL and swaps injected CSS in
   * place. Called on same-origin in-document route changes, where the live
   * session and wrappers stay mounted and the MutationObserver walks the new
   * route's DOM under the new URL's rule.
   *
   * Known tradeoff: site rules are path-scoped in more than CSS (selectors,
   * thresholds), and DOM that persists unchanged across the route keeps the
   * walk decisions made under the previous URL's rule. Accepted — the
   * alternative is the tear-down/re-walk flash this method exists to avoid.
   */
  refreshSiteRuleCSS: () => Promise<void>

  /**
   * Applies the "translate tab title" switch to a running session in place:
   * off puts the page's own title back, on translates it. Body translations
   * stay mounted either way.
   */
  setTitleTranslationEnabled: (enabled: boolean) => void

  /**
   * Registers page translation triggers
   */
  registerPageTranslationTriggers: () => () => void
}

export class PageTranslationManager implements IPageTranslationManager {
  private static readonly MAX_DURATION = 500
  private static readonly MOVE_THRESHOLD = 30 * 30
  /** Max synchronous passes of the retranslation loop per invocation. */
  private static readonly MAX_REFRESH_PASSES = 3
  /** Rolling budget: at most MAX_PASSES_PER_WINDOW passes per source per window. */
  private static readonly RETRANSLATE_WINDOW_MS = 10_000
  private static readonly MAX_PASSES_PER_WINDOW = 6
  private static readonly RETRANSLATE_RETRY_DEBOUNCE_MS = 1_000
  private static readonly DEFAULT_INTERSECTION_OPTIONS: SimpleIntersectionOptions = {
    root: null,
    rootMargin: "600px",
    threshold: 0.1,
  }

  private session: PageSession | undefined
  private get isPageTranslating(): boolean {
    return !!this.session && !this.session.lifetimeSignal.aborted
  }
  /** Non-null while a start() is between its guard and activation; see start(). */
  private pendingStart: symbol | null = null
  private viewport: ViewportScheduler | undefined
  private readonly domObservation = new DOMObservation()
  private walkId: string | null = null
  private readonly onPageHide = () => this.stop()
  private requestSessionUrl: string | undefined
  private contextPrimed = false
  private paragraphChildren = new WeakMap<HTMLElement, HTMLElement[]>()
  private intersectionOptions: IntersectionObserverInit
  private walkBlockedElementsCache = new WeakSet<HTMLElement>()
  private ancestorsWithWalkBlockedElements = new WeakSet<HTMLElement>()
  private refreshingTranslatedSources = new WeakSet<HTMLElement>()
  private translatedSourceMutationVersions = new WeakMap<HTMLElement, number>()
  // Enumerable so an external CSS reveal can retry them; pruned by isConnected
  // on every pass, so a detached source is dropped at the next mutation batch.
  private blockedStaleSources = new Set<HTMLElement>()
  private retranslationBudgets = new WeakMap<HTMLElement, RetranslationBudget>()
  private retranslateRetries = new WeakMap<HTMLElement, DebouncedRetry>()
  // Strong and enumerable so stop() can cancel in-flight retries; entries are
  // removed when a retry fires, so the set only holds armed timers.
  private pendingRetranslateRetries = new Set<DebouncedRetry>()
  private get translationSessionVersion(): number {
    return getPageTranslationSessionVersion()
  }
  /** Pending initial chunked walk; mutation handling serializes behind it. */
  private initialWalkDone: Promise<void> | null = null
  private readonly titleTask = new DocumentTitleTask(() => this.isPageTranslating)
  // The "translate tab title" switch: read when a session starts, then kept
  // current by setTitleTranslationEnabled.
  private titleTranslationEnabled = true

  constructor(
    intersectionOptions: SimpleIntersectionOptions = {},
    private readonly getDetectedPageLanguage: (
      url: string,
    ) => LangCodeISO6393 | "und" | undefined = () => undefined,
  ) {
    if (intersectionOptions.threshold !== undefined) {
      if (intersectionOptions.threshold < 0 || intersectionOptions.threshold > 1) {
        throw new Error("IntersectionObserver threshold must be between 0 and 1")
      }
    }

    this.intersectionOptions = {
      ...PageTranslationManager.DEFAULT_INTERSECTION_OPTIONS,
      ...intersectionOptions,
    }
  }

  get isActive(): boolean {
    return this.isPageTranslating
  }

  async start(): Promise<void> {
    if (this.isPageTranslating) {
      console.warn("PageTranslationManager is already active")
      return
    }
    if (this.pendingStart) {
      console.warn("PageTranslationManager start is already pending")
      return
    }

    // Claim the start slot for the whole pre-activation span: its awaits
    // (config read, availability gate) would otherwise let a second trigger
    // pass the isPageTranslating guard above and run a duplicate initial
    // walk. stop() clears the slot to cancel a still-pending start.
    const startToken = Symbol("page-translation-start")
    this.pendingStart = startToken
    try {
      await this.runStart(startToken)
    } finally {
      if (this.pendingStart === startToken) {
        this.pendingStart = null
      }
    }
  }

  private async runStart(startToken: symbol): Promise<void> {
    const config = await getLocalConfig()
    if (this.pendingStart !== startToken) {
      return
    }
    if (!config) {
      console.warn("Config is not initialized")
      return
    }
    this.titleTranslationEnabled = config.pageTranslation.page.translateTitle

    const requestedProviderConfig = resolvePageTranslationProviderOrNull(config)

    if (
      !validateTranslationConfigAndToast({
        providersConfig: config.providersConfig,
        pageTranslation: config.pageTranslation,
        language: config.language,
      })
    ) {
      return
    }

    // The config validator above already rejects an unresolved provider. Keep the
    // explicit guard for type-safety and for malformed storage snapshots.
    if (!requestedProviderConfig) return

    if (this.pendingStart !== startToken) {
      return
    }

    const providerConfig = resolvePageTranslationProvider(config)

    // Activate before the notify round trip: once the flag is set, stop()
    // is authoritative for teardown, so a cancel arriving during any await
    // below tears the session down instead of racing a pending start. The
    // session-version checks after each await abort the rest of the setup
    // once such a teardown (or a newer session) has happened.
    this.requestSessionUrl = window.location.href
    beginPageTranslationSession(config, getWebPageContentRevision)
    this.session = getPageTranslationSession()!
    this.session.own(() => this.releaseDomResources())
    const sessionVersion = this.translationSessionVersion
    window.addEventListener("pagehide", this.onPageHide)
    this.contextPrimed = false

    try {
      await sendMessage("setAndNotifyPageTranslationStateChangedByManager", {
        enabled: true,
        url: window.location.href,
      })
    } catch (error) {
      // Roll back the not-yet-visible activation locally (the notify
      // channel just failed, so there is no background state to correct);
      // without this the manager would stay "active" with no observers.
      if (this.translationSessionVersion === sessionVersion) {
        this.stopInternal({ notify: false })
      }
      throw error
    }
    if (this.translationSessionVersion !== sessionVersion) {
      return
    }

    const siteRule = getEffectiveSiteRule(config, window.location.href)
    if (siteRule.injectedCss) {
      void ensureSiteRuleCSS(document, siteRule.injectedCss)
    }

    // Capture only source metadata before title translation. Content and
    // summary preparation begin when the walk discovers its first paragraph.
    await this.titleTask.prime(
      config.pageTranslation.enableAIContentAware &&
        canResolvedProviderRefGenerateText(providerConfig),
    )
    if (this.translationSessionVersion !== sessionVersion) {
      return
    }
    // The live value, not the config read above: the switch may have been
    // flipped while this start was awaiting.
    if (this.titleTranslationEnabled) {
      this.titleTask.start()
    }

    // Listen to existing elements when they enter the viewport
    const walkId = getRandomUUID()
    this.walkId = walkId
    const viewport = new ViewportScheduler(this.intersectionOptions, (units) =>
      this.translateIntersectedUnits(units, walkId),
    )
    this.viewport = viewport
    this.session?.own(() => viewport.dispose())

    // Observe mutations BEFORE the chunked walk: page JS runs between walk
    // slices, and records emitted meanwhile must not be lost. The walk only
    // writes data-read-frog-* attributes, which this observer's
    // attributeFilter never reports, so this creates no feedback loop.
    //
    // Root the observer at documentElement, NOT body: routers like Turbo
    // Drive replace the body NODE itself on every visit, and an observer
    // bound to the old body goes permanently blind — the soft URL-change
    // path (refreshSiteRuleCSS) intentionally never re-attaches observers.
    // On documentElement the swap itself surfaces as a childList record
    // with addedNodes=[newBody], which walks the new body like any other
    // inserted subtree.
    this.observeMutations(document.documentElement)

    // Label existing elements in time-sliced chunks (walkability caching is
    // handled by the walk's onBlockedElement callback). Start at
    // documentElement so pre-existing reader roots mounted beside body are
    // included as well as ordinary body content.
    const initialWalk = this.observeTopLevelParagraphs(document.documentElement, config, {
      chunked: true,
    })
    this.initialWalkDone = initialWalk
    try {
      await initialWalk
    } finally {
      // A newer start() may already have installed a newer walk's promise.
      if (this.initialWalkDone === initialWalk) {
        this.initialWalkDone = null
      }
    }
  }

  stop(options?: { userInitiated?: boolean }): void {
    this.stopInternal({ notify: true, userInitiated: options?.userInitiated })
  }

  setTitleTranslationEnabled(enabled: boolean): void {
    this.titleTranslationEnabled = enabled
    if (!this.isPageTranslating) {
      return
    }
    if (enabled) {
      this.titleTask.start()
    } else {
      this.titleTask.dispose()
    }
  }

  async refreshSiteRuleCSS(): Promise<void> {
    // Never tear down wrappers / observers on a route change. A full
    // stop→start flash is what users see as "translations disappear then
    // reappear" on SPA clicks — and both Navigation API events fire
    // synchronously inside pushState, BEFORE the router swaps the DOM, so a
    // teardown here always hits the still-visible previous page. New route
    // content is walked via the existing MutationObserver instead.
    if (!this.isPageTranslating) return
    const config = await getLocalConfig()
    if (!config || !this.isPageTranslating) return
    const url = window.location.href
    if (
      this.requestSessionUrl &&
      this.requestSessionUrl !== url &&
      !isInPageAnchorChange(this.requestSessionUrl, url)
    ) {
      const oldSession = replacePageTranslationSession(config)
      if (oldSession)
        void sendMessage("cancelPageTranslationRequests", { sessionId: oldSession }).catch(() =>
          logger.warn("Failed to cancel navigation requests"),
        )
      this.session = getPageTranslationSession()
      releaseWebPageContext()
      this.contextPrimed = false
      this.titleTask.invalidate()
    }
    this.requestSessionUrl = url

    const siteRule = getEffectiveSiteRule(config, window.location.href)
    if (siteRule.injectedCss) {
      // ensureSiteRuleCSS replaces the existing sheet's contents in place —
      // no remove-first, which would leave a gap with no site CSS applied
      // and flash layout on rules that exist to pin it (e.g. cnbc.com).
      void ensureSiteRuleCSS(document, siteRule.injectedCss)
    } else {
      removeSiteRuleCSS(document)
    }
  }

  private stopInternal({
    notify,
    userInitiated,
  }: {
    notify: boolean
    userInitiated?: boolean
  }): void {
    // Cancel a start() still awaiting its pre-activation gates: the manager
    // is not active yet, so the guard below would no-op this stop and the
    // pending start would activate translation after the user cancelled.
    this.pendingStart = null
    window.removeEventListener("pagehide", this.onPageHide)

    if (!this.isPageTranslating) {
      console.warn("PageTranslationManager is already inactive")
      return
    }

    if (notify) {
      void sendMessage("setAndNotifyPageTranslationStateChangedByManager", {
        enabled: false,
        url: window.location.href,
        userInitiated,
      })
    }

    // Drain this session's queued/in-flight requests after cancellation.
    // Fire-and-forget: the synchronous DOM
    // cleanup below finishes long before any rejection lands.
    const endedSessionId = endPageTranslationSession()
    if (endedSessionId) {
      void sendMessage("cancelPageTranslationRequests", { sessionId: endedSessionId }).catch(() =>
        logger.warn("Failed to cancel pending translation requests"),
      )
    }
  }

  private releaseDomResources(): void {
    window.removeEventListener("pagehide", this.onPageHide)
    this.session = undefined
    this.walkId = null
    this.contextPrimed = false
    this.paragraphChildren = new WeakMap()
    this.walkBlockedElementsCache = new WeakSet()
    this.ancestorsWithWalkBlockedElements = new WeakSet()
    this.refreshingTranslatedSources = new WeakSet()
    this.translatedSourceMutationVersions = new WeakMap()
    this.blockedStaleSources.clear()
    this.pendingRetranslateRetries.forEach((retry) => retry.clear())
    this.pendingRetranslateRetries.clear()
    this.retranslateRetries = new WeakMap()
    this.retranslationBudgets = new WeakMap()
    this.titleTask.dispose()

    this.viewport?.dispose()
    this.viewport = undefined
    this.domObservation.dispose()

    removeSiteRuleCSS(document)
    removeAllTranslatedWrapperNodes()
    cleanupNodeSiteRuleCSSIfUnused(document)
  }

  registerPageTranslationTriggers(): () => void {
    let startTime = 0
    let startTouches: TouchList | null = null

    const reset = () => {
      startTime = 0
      startTouches = null
    }

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 4) {
        startTime = performance.now()
        startTouches = e.touches
      } else {
        reset()
      }
    }

    const onMove = (e: TouchEvent) => {
      if (!startTouches) return
      if (e.touches.length !== 4) return reset()

      for (let i = 0; i < 4; i++) {
        const dx = e.touches[i]!.clientX - startTouches[i]!.clientX
        const dy = e.touches[i]!.clientY - startTouches[i]!.clientY
        if (dx * dx + dy * dy > PageTranslationManager.MOVE_THRESHOLD) return reset()
      }
    }

    const onEnd = () => {
      if (!startTouches) return
      if (performance.now() - startTime < PageTranslationManager.MAX_DURATION) {
        if (this.isPageTranslating) {
          this.stop({ userInitiated: true })
        } else {
          void this.start()
        }
      }
      reset()
    }

    document.addEventListener("touchstart", onStart, { passive: true })
    document.addEventListener("touchmove", onMove, { passive: true })
    document.addEventListener("touchend", onEnd, { passive: true })
    document.addEventListener("touchcancel", reset, { passive: true })

    // Teardown: remove all touch listeners
    return () => {
      document.removeEventListener("touchstart", onStart)
      document.removeEventListener("touchmove", onMove)
      document.removeEventListener("touchend", onEnd)
      document.removeEventListener("touchcancel", reset)
    }
  }

  private async observeTopLevelParagraphs(
    container: HTMLElement,
    existingConfig?: Config,
    options: { chunked?: boolean } = {},
  ): Promise<void> {
    const observer = this.viewport
    // Capture locals: this method awaits, and `this.walkId` may belong to a
    // newer session by the time an await resumes.
    const walkId = this.walkId
    if (!walkId || !observer) return

    const config = existingConfig ?? (await getLocalConfig())
    if (!config) {
      logger.error("Global config is not initialized")
      return
    }
    if (this.walkId !== walkId) return

    // Skip if container has an ancestor that should not be walked into
    if (hasNoWalkAncestor(container, config)) return

    const discovered: HTMLElement[] = []
    const onParagraph = (element: HTMLElement) => {
      discovered.push(element)
      if (!this.contextPrimed) {
        this.contextPrimed = true
        primePageTranslationContext(config)
      }
    }
    const onBlockedElement = (element: HTMLElement) => {
      this.cacheWalkBlockedElement(element)
    }
    if (options.chunked !== false) {
      const result = await walkAndLabelElementChunked(container, walkId, config, {
        onBlockedElement,
        onParagraph,
        signal: this.session?.lifetimeSignal,
        shouldContinue: () => this.isPageTranslating && this.walkId === walkId,
      })
      if (result === null || this.walkId !== walkId) return
    } else {
      walkAndLabelElement(container, walkId, config, { onBlockedElement, onParagraph })
    }

    // if container itself has paragraph and the id
    if (
      container.hasAttribute("data-read-frog-paragraph") &&
      container.getAttribute("data-read-frog-walked") === walkId
    ) {
      await this.observeParagraphUnit(container, walkId, config, 0)
      return
    }

    const paragraphs = discovered.length
      ? discovered
      : this.collectParagraphElementsDeep(container, walkId)
    await pageLocalScheduler.run(
      this.registerDiscoveredParagraphs(paragraphs, container, walkId, config),
      {
        current: () => this.walkId === walkId,
        signal: this.session?.lifetimeSignal,
      },
    )
  }

  private *registerDiscoveredParagraphs(
    paragraphs: HTMLElement[],
    container: HTMLElement,
    walkId: string,
    config: Config,
  ): Generator<void> {
    const descendants = new Map<HTMLElement, HTMLElement[]>()
    for (const paragraph of paragraphs) {
      yield
      const parent = paragraph.parentElement?.closest<HTMLElement>("[data-read-frog-paragraph]")
      if (parent && parent !== paragraph) {
        const children = descendants.get(parent) ?? []
        children.push(paragraph)
        descendants.set(parent, children)
      }
    }
    for (const [parent, children] of descendants) this.paragraphChildren.set(parent, children)
    for (const paragraph of paragraphs) {
      yield
      const ancestor = paragraph.parentElement?.closest("[data-read-frog-paragraph]")
      if (!ancestor || !container.contains(ancestor))
        yield* this.expandParagraphUnits(paragraph, walkId, config, 0)
    }
  }

  /**
   * Observe a paragraph as one lazy-translation unit — unless it is so tall
   * that its first intersection would expand into (nearly) the whole page at
   * once. docs.docker.com labels its entire flat 185k-px <article> as ONE
   * paragraph (inline <em> dates are direct children), which defeated
   * viewport gating and enqueued 5k+ paragraphs instantly (#1881). Giant
   * paragraphs are split: their next-level descendant paragraphs are observed
   * individually instead.
   *
   * The split is only sound when the giant owns no prose of its own: by the
   * labeling rule every other character inside it already sits in one of the
   * chosen units. That holds on docs.docker.com (its <article>'s own direct
   * text is zero chars) but inverts on <br>-delimited article bodies, where
   * the bare text IS the article and the inline <i>/<span> fragments are the
   * strays — splitting there stranded 92% of a Blogger post and 98.9% of
   * paulgraham.com/greatwork.html, and gave the stray <i> its own
   * mid-sentence translation. See canSplitGiantWithoutStrandingOwnText.
   *
   * Exception: a newline-preserving flow container is never split into
   * inline descendants — see canSplitParagraphIntoDescendants.
   */
  private async observeParagraphUnit(
    element: HTMLElement,
    walkId: string,
    config: Config,
    depth: number,
  ): Promise<void> {
    await pageLocalScheduler.run(this.expandParagraphUnits(element, walkId, config, depth), {
      current: () => this.walkId === walkId,
      signal: this.session?.lifetimeSignal,
    })
  }

  private *expandParagraphUnits(
    element: HTMLElement,
    walkId: string,
    config: Config,
    depth: number,
  ): Generator<void> {
    yield
    const observer = this.viewport
    if (!observer) return

    if (depth >= GIANT_PARAGRAPH_MAX_SPLIT_DEPTH || renderedHeight(element) <= maxUnitHeight()) {
      observer.observe(element)
      return
    }

    const innerTopLevelParagraphs = (
      this.paragraphChildren.get(element) ?? this.collectParagraphElementsDeep(element, walkId)
    ).filter((paragraph) => {
      if (paragraph === element) return false
      const ancestor = paragraph.parentElement?.closest("[data-read-frog-paragraph]")
      // Keep only paragraphs whose nearest paragraph ancestor is the giant
      // itself (or that have none inside it, e.g. across shadow roots).
      return !ancestor || ancestor === element || !element.contains(ancestor)
    })
    if (innerTopLevelParagraphs.length === 0) {
      // Unsplittable giant (no nested paragraphs) — observe it whole.
      observer.observe(element)
      return
    }
    if (
      // Bounded by the very thing #1881 measures as harm: how many units one
      // intersection enqueues. Above the cap, keeping viewport gating beats
      // rescuing the giant's own text.
      innerTopLevelParagraphs.length <= GIANT_SPLIT_STRANDED_TEXT_MAX_UNITS &&
      // <body> is force-block and picks up a paragraph label from any stray
      // direct text node, so refusing there would collapse the whole document
      // into ONE observed unit — the outcome the traversal's document-root
      // guard exists to prevent (gating dies, and the translated-region
      // querySelector becomes a document-wide silent skip).
      element !== element.ownerDocument.body &&
      !canSplitGiantWithoutStrandingOwnText(element)
    ) {
      observer.observe(element)
      return
    }
    if (!canSplitParagraphIntoDescendants(element, innerTopLevelParagraphs, config)) {
      // A newline-preserving flow (X note tweet: pre-wrap div of inline
      // rich-text <span> paragraphs,
      // https://x.com/davidjpark96/status/1789773192435060737) must not be
      // split when the container-level virtual-paragraph plan can segment it
      // instead — per-span observation translates each span as one blob,
      // destroying the blank-line paragraph structure.
      // Both modes now have such a plan, but they need different things from
      // it, which is why the decision lives in canSplitParagraphIntoDescendants
      // rather than here: bilingual can interleave a wrapper at any boundary,
      // while translationOnly has to cut the units apart into whole nodes and
      // therefore keeps per-span observation for the plans it cannot express.
      observer.observe(element)
      return
    }
    for (const paragraph of innerTopLevelParagraphs) {
      yield* this.expandParagraphUnits(paragraph, walkId, config, depth + 1)
    }
  }

  private translateIntersectedUnits(units: HTMLElement[], walkId: string): void {
    if (units.length === 0) return
    void (async () => {
      // One config read per callback batch — a dense first intersection
      // can deliver hundreds of entries at once (#1881).
      const currentConfig = await getLocalConfig()
      if (!currentConfig) {
        logger.error("Global config is not initialized")
        return
      }
      if (this.walkId !== walkId) return
      // All viewport callbacks use the same local scheduler. Only local work
      // is serialized; each paragraph's network request remains concurrent.
      const isWalkCurrent = () => this.walkId === walkId
      const signal = this.session?.signal
      await pageLocalScheduler.run(
        (function* () {
          for (const unit of units) {
            yield
            void Promise.resolve(
              translateWalkedElement(unit, walkId, currentConfig, false, isWalkCurrent),
            ).catch((error) => logger.warn("Viewport translation failed", error))
          }
        })(),
        { current: isWalkCurrent, signal, foreground: true },
      )
    })()
  }

  /**
   * Recursively collect elements with paragraph attributes from shadow roots and iframes
   */
  private collectParagraphElementsDeep(container: HTMLElement, walkId: string): HTMLElement[] {
    const result: HTMLElement[] = []

    const collectFromContainer = (root: HTMLElement | Document | ShadowRoot) => {
      const elements = root.querySelectorAll<HTMLElement>(
        `[data-read-frog-paragraph][data-read-frog-walked="${CSS.escape(walkId)}"]`,
      )
      result.push(...[...elements])
    }

    const traverseElement = (element: HTMLElement) => {
      if (element.shadowRoot) {
        collectFromContainer(element.shadowRoot)
        for (const child of element.shadowRoot.children) {
          if (child instanceof HTMLElement) {
            traverseElement(child)
          }
        }
      }

      for (const child of element.children) {
        if (child instanceof HTMLElement) {
          traverseElement(child)
        }
      }
    }

    collectFromContainer(container)
    traverseElement(container)

    return result
  }

  /**
   * Track the same blocked states that the traversal skips, so hidden accordion
   * panels can be re-walked when the site reveals an existing subtree.
   */
  private isWalkBlockedElement(element: HTMLElement, config: Config): boolean {
    return isWalkBlockedElementFilter(element, config)
  }

  private cacheWalkBlockedElement(element: HTMLElement): void {
    this.walkBlockedElementsCache.add(element)
    let current: HTMLElement | null = element
    while (current) {
      const root = current.getRootNode()
      current =
        current.parentElement ?? (root instanceof ShadowRoot ? (root.host as HTMLElement) : null)
      if (current) this.ancestorsWithWalkBlockedElements.add(current)
    }
  }

  private collectNewlyWalkableSubtrees(element: HTMLElement, config: Config): HTMLElement[] {
    if (this.didChangeToWalkable(element, config)) return [element]
    if (
      this.walkBlockedElementsCache.has(element) ||
      !this.ancestorsWithWalkBlockedElements.has(element)
    )
      return []

    // Ancestor selectors can reveal a cached descendant without changing the
    // ancestor's own walkability. Only follow branches leading to cached
    // blockers; ordinary class/style churn must not scan the entire subtree.
    // Weak membership avoids retaining detached nodes through their ancestors.
    const result: HTMLElement[] = []
    const children = [...element.children, ...(element.shadowRoot?.children ?? [])]
    for (const child of children) {
      if (
        isHTMLElement(child) &&
        (this.walkBlockedElementsCache.has(child) ||
          this.ancestorsWithWalkBlockedElements.has(child))
      ) {
        result.push(...this.collectNewlyWalkableSubtrees(child, config))
      }
    }
    return result
  }

  /**
   * Handle attribute changes and only trigger observation
   * when element transitions from blocked to walkable.
   */
  private didChangeToWalkable(element: HTMLElement, config: Config): boolean {
    const wasWalkBlocked = this.walkBlockedElementsCache.has(element)
    const isWalkBlockedNow = this.isWalkBlockedElement(element, config)

    // Update cache with current state
    if (isWalkBlockedNow) {
      this.cacheWalkBlockedElement(element)
    } else {
      this.walkBlockedElementsCache.delete(element)
    }

    return wasWalkBlocked && !isWalkBlockedNow
  }

  /**
   * Start observing mutations for a container and all its shadow roots
   */
  private observeMutations(container: HTMLElement, config?: Config, discover = true): void {
    this.domObservation.observe(container, (records, root) => {
      void this.handleMutationRecords(records, root).catch((error) =>
        logger.warn("Mutation processing failed", error),
      )
    })
    if (discover) this.observeIsolatedDescendantsMutations(container, config)
  }

  private static readonly SELF_NODE_CLASSES = [
    CONTENT_WRAPPER_CLASS,
    REACT_SHADOW_HOST_CLASS,
    SPINNER_CLASS,
  ]

  private isExtensionUtilityNode(node: Node): boolean {
    return (
      isHTMLElement(node) &&
      PageTranslationManager.SELF_NODE_CLASSES.some((cls) => node.classList.contains(cls))
    )
  }

  /**
   * Mutations the extension itself causes (wrapper/spinner/error-UI churn) must
   * not re-enter the staleness/traversal pipeline, or every translation becomes
   * fuel for the next retranslation (#1831). Site-driven removals of our
   * wrappers stay classified as host mutations so they retranslate once.
   */
  private isSelfInflictedRecord(
    record: MutationRecord,
    checkedWrappers?: WeakMap<HTMLElement, boolean>,
  ): boolean {
    // Wrapper classes/styles are set before insertion and data-read-frog-*
    // labels are not observed, so attribute records are never self-caused.
    if (record.type === "attributes") return false
    // In-place swaps/restores write the site's own text nodes (no wrapper
    // ancestor); classify by the exact value the extension last wrote.
    if (record.type === "characterData" && wasCharacterDataChangeExtensionDriven(record.target)) {
      return true
    }
    // The LaTeXML reflow swaps an SVG box for a card during the walk that
    // already labels the card's content; walking it again would translate the
    // box twice.
    if (isLatexmlTextBoxReflowRecord(record)) return true
    const targetElement = isHTMLElement(record.target) ? record.target : record.target.parentElement
    const wrapperElement = targetElement?.closest<HTMLElement>(`.${CONTENT_WRAPPER_CLASS}`)
    if (wrapperElement) {
      // In-wrapper churn is normally our own (#1831) — but a divergence from
      // the post-insertion snapshot means the SITE rewrote our wrapper content
      // (truncation scripts like CNBC's, #1918). Those records must reach the
      // staleness walk so the budgeted retranslation repairs the wrapper. The
      // null snapshot covers the construction window and error-UI wrappers,
      // keeping their churn classified self-inflicted exactly as before.
      const previous = checkedWrappers?.get(wrapperElement)
      if (previous !== undefined) return previous
      const state = getBilingualTranslationStateForWrapper(wrapperElement)
      const own = !(
        state &&
        state.wrapperTextContent !== null &&
        wrapperElement.textContent !== state.wrapperTextContent
      )
      checkedWrappers?.set(wrapperElement, own)
      return own
    }
    if (record.type !== "childList") return false
    const added = [...record.addedNodes]
    const removed = [...record.removedNodes]
    if (added.length === 0 && removed.length === 0) return false
    return (
      added.every((node) => this.isExtensionUtilityNode(node)) &&
      removed.every((node) => this.isExtensionUtilityNode(node) && wasNodeRemovedByExtension(node))
    )
  }

  /**
   * When the SITE removes a subtree containing our error UI or spinners, none
   * of the extension's cleanup paths run: the React root never unmounts and
   * its window.matchMedia listener + store subscription pin the detached
   * subtree forever; infinite spinner animations likewise root their targets.
   */
  private cleanupDetachedTranslationArtifacts(removedNodes: NodeList): void {
    for (const node of removedNodes) {
      if (!isHTMLElement(node) || node.isConnected) continue
      if (wasNodeRemovedByExtension(node)) continue
      if (node.classList.contains(REACT_SHADOW_HOST_CLASS)) {
        removeReactShadowHost(node)
        continue
      }
      if (!node.firstElementChild) continue
      node
        .querySelectorAll<HTMLElement>(`.${REACT_SHADOW_HOST_CLASS}`)
        .forEach((host) => removeReactShadowHost(host))
      node
        .querySelectorAll<HTMLElement>(`.${SPINNER_CLASS}`)
        .forEach((spinner) => cancelSpinnerAnimation(spinner))
    }
  }

  /**
   * Re-check the shadow hosts enclosing an isolated observer before its records
   * are processed.
   *
   * Document observers cannot cross shadow boundaries, so isolated observers stay
   * registered even while their host is blocked. Sibling selectors and other
   * external CSS can reveal such a host without mutating it or any of its
   * ancestors, so the enclosing chain has to be re-tested per batch rather than
   * trusted from registration time.
   *
   * Returns `null` when the caller must abandon the batch (a host is still
   * blocked, config is missing, or the session moved on). Otherwise returns the
   * config it had to resolve — the caller reuses it instead of fetching twice —
   * and the host whose reveal this call recovered, if any.
   *
   * Side effect: when a host is still blocked this defers the caller's
   * `staleTranslatedSources` into `blockedStaleSources`, so they are retried
   * once a later batch observes the reveal.
   */
  private async resolveShadowObservationGate(
    observationRoot: HTMLElement,
    hostRecords: MutationRecord[],
    staleTranslatedSources: Set<HTMLElement>,
    sessionVersion: number,
  ): Promise<{ config?: Config; revealedRoot?: HTMLElement } | null> {
    const shadowWalkRoots: HTMLElement[] = []
    let root = observationRoot.getRootNode()
    while (root instanceof ShadowRoot) {
      if (isHTMLElement(root.host)) shadowWalkRoots.unshift(root.host)
      root = root.host.getRootNode()
    }
    if (shadowWalkRoots.length === 0) return {}

    // The observed top-level shadow child and its light-DOM ancestors can
    // also be blocked, independently of the enclosing shadow hosts.
    shadowWalkRoots.push(observationRoot)
    const config = await getLocalConfig()
    if (!config) {
      logger.error("Global config is not initialized")
      return null
    }
    if (!this.isPageTranslating || this.translationSessionVersion !== sessionVersion) return null

    let revealedRoot: HTMLElement | undefined
    for (const host of shadowWalkRoots) {
      if (hasNoWalkAncestor(host, config) || this.isWalkBlockedElement(host, config)) {
        this.cacheWalkBlockedElement(host)
        staleTranslatedSources.forEach((source) => this.blockedStaleSources.add(source))
        // A hidden tree may itself receive more isolated roots. Register
        // them too, without labeling or translating any of their content.
        for (const record of hostRecords) {
          if (record.type !== "childList") continue
          for (const node of record.addedNodes) {
            if (isHTMLElement(node)) this.observeIsolatedDescendantsMutations(node, config)
          }
        }
        return null
      }
      if (this.walkBlockedElementsCache.has(host)) {
        revealedRoot ??= host
      }
    }

    if (revealedRoot) {
      shadowWalkRoots.forEach((host) => this.walkBlockedElementsCache.delete(host))
      // Also recover on a characterData-only first update, before the
      // ordinary fast path rejects text with no registered translation.
      void this.observeTopLevelParagraphs(revealedRoot, config)
      this.observeIsolatedDescendantsMutations(revealedRoot, config)
    }
    return { config, revealedRoot }
  }

  private async handleMutationRecords(
    records: MutationRecord[],
    observationRoot: HTMLElement,
  ): Promise<void> {
    const sessionVersion = this.translationSessionVersion
    const hostRecords: MutationRecord[] = []
    const checkedWrappers = new WeakMap<HTMLElement, boolean>()
    for (const record of records) {
      if (record.type === "childList") {
        // Must run before the first await: carrying is only invisible while
        // layout has not seen the rewrite yet.
        if (this.isPageTranslating && this.walkId) {
          carryTranslationsAcrossRewrite(record, this.walkId)
        }
        this.cleanupDetachedTranslationArtifacts(record.removedNodes)
      }
      if (!this.isSelfInflictedRecord(record, checkedWrappers)) hostRecords.push(record)
    }
    if (hostRecords.length === 0) return

    // Serialize traversal-driven handling behind the initial chunked walk so
    // a mutation-path sync walk never races the sliced startup walk over the
    // same subtree. Records are static snapshots, so deferring is safe; the
    // detached-artifact cleanup above already ran promptly.
    if (this.initialWalkDone) {
      await this.initialWalkDone
      if (!this.isPageTranslating || this.translationSessionVersion !== sessionVersion) return
    }

    const staleTranslatedSources = new Set<HTMLElement>()
    const checkedBilingualSources = new WeakMap<HTMLElement, boolean>()
    const checkedSwapSources = new WeakMap<HTMLElement, boolean>()
    for (const record of hostRecords) {
      const staleSource = findStaleBilingualLayoutSource(record.target, checkedBilingualSources)
      if (staleSource) staleTranslatedSources.add(staleSource)
      // In-place-swapped anchors must also recover after host edits.
      const staleAnchor = findStaleTranslationOnlyAnchor(record.target, checkedSwapSources)
      if (staleAnchor) staleTranslatedSources.add(staleAnchor)
    }
    staleTranslatedSources.forEach((source) => {
      const nextVersion = (this.translatedSourceMutationVersions.get(source) ?? 0) + 1
      this.translatedSourceMutationVersions.set(source, nextVersion)
    })

    const gate = await this.resolveShadowObservationGate(
      observationRoot,
      hostRecords,
      staleTranslatedSources,
      sessionVersion,
    )
    if (!gate) return
    const { config: mutationConfig, revealedRoot } = gate

    const needsTraversalHandling = hostRecords.some((record) => record.type !== "characterData")
    if (
      staleTranslatedSources.size === 0 &&
      this.blockedStaleSources.size === 0 &&
      !needsTraversalHandling
    )
      return

    const config = mutationConfig ?? (await getLocalConfig())
    if (!config) {
      logger.error("Global config is not initialized")
      return
    }
    if (!this.isPageTranslating || this.translationSessionVersion !== sessionVersion) return

    // A reveal can mutate an ancestor or a CSS-controlling sibling rather than
    // the edited source. Retry pending sources on the next observable update.
    for (const source of this.blockedStaleSources) {
      if (source.isConnected && this.isSourceWalkBlocked(source, config)) continue
      this.blockedStaleSources.delete(source)
      if (source.isConnected) staleTranslatedSources.add(source)
    }

    // Recovery already walked and registered the whole enclosing tree. Still
    // refresh stale translations below, but do not walk each addition again.
    const traversalRecords = revealedRoot ? [] : hostRecords
    const scannedAdditions = new Set<HTMLElement>()
    for (const rec of traversalRecords) {
      if (rec.type === "childList") {
        this.viewport?.unobserveRemovedGates(rec)
        // A node added inside an already-registered bilingual source is that
        // source's business, never a translation unit of its own. Walking it as
        // a fresh walk root recomputes "top-level paragraph" relative to the
        // addition, so an inline span promotes itself to a unit and gets a
        // second wrapper inside the enclosing one; Google Search's citation
        // hover then unwraps its decorator preserving children and the
        // duplicate stays (#2185).
        //
        // Skipping strands nothing — see findEnclosingBilingualLayoutSource for
        // the current/stale duality that makes this safe. Shadow text is
        // invisible to collectHostText, so isolated trees inside the addition
        // are still discovered and scanned.
        if (findEnclosingBilingualLayoutSource(rec.target)) {
          rec.addedNodes.forEach((node) => {
            if (isHTMLElement(node)) {
              this.observeIsolatedDescendantsMutations(node, config, { scanIsolatedTrees: true })
            }
          })
          continue
        }
        rec.addedNodes.forEach((node) => {
          if (isHTMLElement(node) && !scannedAdditions.has(node)) {
            scannedAdditions.add(node)
            void this.observeTopLevelParagraphs(node, config)
            this.observeIsolatedDescendantsMutations(node, config)
          }
        })
      } else if (this.isWalkabilityAttributeMutation(rec)) {
        const el = rec.target
        if (!isHTMLElement(el)) continue
        for (const unblocked of this.collectNewlyWalkableSubtrees(el, config)) {
          void this.observeTopLevelParagraphs(unblocked, config)
          // A blocked addition under a current source can skip isolated-tree
          // registration. Observe future shadow mutations when it unblocks.
          // Descendant hosts may still be blocked after this ancestor opens.
          this.observeIsolatedDescendantsMutations(unblocked, config)
        }
      }
    }

    await Promise.all(
      [...staleTranslatedSources].map((source) =>
        this.retranslateChangedSource(source, config, sessionVersion),
      ),
    )
  }

  private isSourceWalkBlocked(source: HTMLElement, config: Config): boolean {
    let current = source
    while (true) {
      if (hasNoWalkAncestor(current, config) || this.isWalkBlockedElement(current, config))
        return true
      const root = current.getRootNode()
      if (!(root instanceof ShadowRoot) || !isHTMLElement(root.host)) return false
      current = root.host
    }
  }

  private async retranslateChangedSource(
    source: HTMLElement,
    config: Config,
    sessionVersion: number,
  ): Promise<void> {
    const walkId = this.walkId
    const refreshingSources = this.refreshingTranslatedSources
    const mutationVersions = this.translatedSourceMutationVersions
    if (
      !this.isPageTranslating ||
      this.translationSessionVersion !== sessionVersion ||
      !walkId ||
      !source.isConnected ||
      refreshingSources.has(source)
    ) {
      return
    }

    refreshingSources.add(source)
    let handledVersion = 0
    let passes = 0
    try {
      do {
        if (this.isSourceWalkBlocked(source, config)) {
          this.blockedStaleSources.add(source)
          return
        }
        if (!this.consumeRetranslationBudget(source)) {
          // Budget exhausted: converge later instead of looping now (#1831).
          this.scheduleRetranslateRetry(source, sessionVersion)
          return
        }
        passes += 1
        handledVersion = mutationVersions.get(source) ?? 0
        if (config.pageTranslation.mode === "translationOnly") {
          // Swapped-anchor staleness: translateNodes routes to the
          // translationOnly path, which restores surviving swaps first so the
          // provider sees current host text, then re-swaps. Keyed on the MODE,
          // not on anchor-state presence — a scheduled retry must never insert
          // bilingual wrappers into a translationOnly session.
          await translateNodes([source], walkId, false, config)
        } else {
          walkAndLabelElement(source, walkId, config)
          await translateNodesBilingualMode([source], walkId, config)
        }
      } while (
        this.isPageTranslating &&
        this.translationSessionVersion === sessionVersion &&
        this.walkId === walkId &&
        source.isConnected &&
        (mutationVersions.get(source) ?? 0) !== handledVersion &&
        passes < PageTranslationManager.MAX_REFRESH_PASSES
      )
      if (
        this.isPageTranslating &&
        this.translationSessionVersion === sessionVersion &&
        this.walkId === walkId &&
        source.isConnected &&
        (mutationVersions.get(source) ?? 0) !== handledVersion
      ) {
        // Still dirty after the pass cap — defer the follow-up.
        this.scheduleRetranslateRetry(source, sessionVersion)
      }
    } finally {
      refreshingSources.delete(source)
      if (mutationVersions.get(source) === handledVersion) {
        mutationVersions.delete(source)
      }
    }
  }

  private consumeRetranslationBudget(source: HTMLElement): boolean {
    const now = Date.now()
    const budget = this.retranslationBudgets.get(source)
    if (!budget || now - budget.windowStart > PageTranslationManager.RETRANSLATE_WINDOW_MS) {
      this.retranslationBudgets.set(source, { windowStart: now, passes: 1 })
      return true
    }
    if (budget.passes >= PageTranslationManager.MAX_PASSES_PER_WINDOW) return false
    budget.passes += 1
    return true
  }

  private scheduleRetranslateRetry(source: HTMLElement, sessionVersion: number): void {
    let retry = this.retranslateRetries.get(source)
    if (!retry) {
      const debounced = debounce(() => {
        this.pendingRetranslateRetries.delete(debounced)
        void this.runScheduledRetranslate(source, sessionVersion)
      }, PageTranslationManager.RETRANSLATE_RETRY_DEBOUNCE_MS) as unknown as DebouncedRetry
      retry = debounced
      this.retranslateRetries.set(source, retry)
    }
    this.pendingRetranslateRetries.add(retry)
    retry()
  }

  private async runScheduledRetranslate(
    source: HTMLElement,
    sessionVersion: number,
  ): Promise<void> {
    if (!this.isPageTranslating || this.translationSessionVersion !== sessionVersion) return
    // No pending mutation version means the source converged in the meantime.
    if (this.translatedSourceMutationVersions.get(source) === undefined) return
    const config = await getLocalConfig()
    if (!config) return
    if (!this.isPageTranslating || this.translationSessionVersion !== sessionVersion) return
    await this.retranslateChangedSource(source, config, sessionVersion)
  }

  private isWalkabilityAttributeMutation(record: MutationRecord): boolean {
    return (
      record.type === "attributes" &&
      (record.attributeName === "style" ||
        record.attributeName === "class" ||
        record.attributeName === "hidden" ||
        record.attributeName === "aria-hidden")
    )
  }

  /**
   * Recursively find and observe shadow roots and iframes in an element and its descendants
   * These can't be found as top level paragraph elements because isolated shadow roots and iframes are not
   * considered as part of the document.
   */
  private observeIsolatedDescendantsMutations(
    element: HTMLElement,
    config?: Config,
    options: { scanIsolatedTrees?: boolean } = {},
  ): void {
    const walkId = this.walkId
    const iterator = this.discoverIsolatedRoots(element, config, options.scanIsolatedTrees ?? false)
    void pageLocalScheduler
      .run(iterator, {
        current: () => this.walkId === walkId && this.isPageTranslating,
        signal: this.session?.lifetimeSignal,
      })
      .catch((error) => logger.warn("Isolated-root discovery failed", error))
  }

  private *discoverIsolatedRoots(
    element: HTMLElement,
    config: Config | undefined,
    scan: boolean,
  ): Generator<void> {
    const stack = [{ element, walkable: !config || !hasNoWalkAncestor(element, config), scan }]
    while (stack.length) {
      yield
      const entry = stack.pop()!
      const current = entry.element
      let walkable = entry.walkable
      if (config && walkable && this.isWalkBlockedElement(current, config)) {
        this.cacheWalkBlockedElement(current)
        walkable = false
      }
      if (current.shadowRoot) {
        for (const child of current.shadowRoot.children) {
          if (!isHTMLElement(child)) continue
          this.observeMutations(child, config, false)
          if (config && entry.scan && walkable) void this.observeTopLevelParagraphs(child, config)
          stack.push({ element: child, walkable, scan: false })
        }
      }
      for (let index = current.children.length - 1; index >= 0; index--) {
        const child = current.children[index]!
        if (isHTMLElement(child)) stack.push({ element: child, walkable, scan: entry.scan })
      }
    }
  }
}

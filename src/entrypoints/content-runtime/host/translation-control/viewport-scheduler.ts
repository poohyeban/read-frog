import { CONTENT_WRAPPER_CLASS } from "@/utils/constants/dom-labels"
import {
  GIANT_PARAGRAPH_SPLIT_MIN_VIEWPORT_PX,
  GIANT_PARAGRAPH_SPLIT_VIEWPORT_MULTIPLIER,
} from "@/utils/constants/translate"
import { isHTMLElement } from "@/utils/host/dom/filter"
import { deepQueryAllSelector } from "@/utils/host/dom/find"

/**
 * Whether IntersectionObserver can see `element` at all. A `display: contents`
 * element generates no box: its rect is 0×0 and the observer reports it once
 * as not intersecting, then never again.
 */
function hasBox(element: Element): boolean {
  return element.getClientRects().length > 0
}

/**
 * The boxes a box-less element is rendered through: its nearest descendants
 * that have a box, reached through box-less descendants only, shadow roots
 * included (a `display: contents` custom element renders its shadow tree).
 */
function collectRenderedBoxes(element: Element, boxes: Element[] = []): Element[] {
  for (const child of [...element.children, ...(element.shadowRoot?.children ?? [])]) {
    if (hasBox(child)) boxes.push(child)
    else collectRenderedBoxes(child, boxes)
  }
  return boxes
}

/** The parent element, continuing from the top of a shadow root to its host. */
function parentElementAcrossShadow(element: Element): Element | null {
  const root = element.getRootNode()
  return element.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
}

/**
 * Whether `element` is box-less because it, or an ancestor below its nearest
 * rendered one, is `display: none`: a closed menu a site rule opened to the
 * walk (`walkHiddenSelectors`), where it gets a box of its own once the site
 * shows it. A `display: contents` element never gets one, open or closed, so
 * it does not count.
 */
function isInHiddenRegion(element: Element): boolean {
  if (window.getComputedStyle(element).display === "contents") return false
  for (
    let current: Element | null = element;
    current && !hasBox(current);
    current = parentElementAcrossShadow(current)
  ) {
    if (window.getComputedStyle(current).display === "none") return true
  }
  return false
}

/**
 * The box a box-less element's content is laid out in: its nearest ancestor
 * that has a box, through shadow roots (a plain-text unit at the top of one is
 * laid out in its host).
 */
function findLayoutBox(element: Element): Element | null {
  for (
    let ancestor = parentElementAcrossShadow(element);
    ancestor;
    ancestor = parentElementAcrossShadow(ancestor)
  ) {
    if (hasBox(ancestor)) return ancestor
  }
  return null
}

/**
 * How tall everything laid out in `box` is. A scroll container's own box is
 * only its viewport, but all the units inside it are taken together when it
 * intersects, so its scroll extent is what has to fit a split-sized unit.
 */
function layoutExtent(box: Element): number {
  return Math.max(box.getBoundingClientRect().height, box.scrollHeight)
}

/**
 * Height used by the giant-unit split. A box-less unit is measured across the
 * boxes it renders through, counting what each lays out (a scrolling list
 * inside it holds its whole history); its own 0×0 rect would let a tall one
 * pass as short and translate whole on the first intersection (#1881). Units
 * with a box keep their own height, zero included.
 */
export function renderedHeight(unit: HTMLElement): number {
  const { height } = unit.getBoundingClientRect()
  if (height > 0 || hasBox(unit)) return height

  let top = Infinity
  let bottom = -Infinity
  for (const box of collectRenderedBoxes(unit)) {
    const rect = box.getBoundingClientRect()
    top = Math.min(top, rect.top)
    bottom = Math.max(bottom, rect.top + layoutExtent(box))
  }
  return bottom > top ? bottom - top : 0
}

/** The tallest unit translated in one go; taller ones are split first (#1881). */
export function maxUnitHeight(): number {
  return (
    Math.max(window.innerHeight, GIANT_PARAGRAPH_SPLIT_MIN_VIEWPORT_PX) *
    GIANT_PARAGRAPH_SPLIT_VIEWPORT_MULTIPLIER
  )
}

/** The same cap across, for content laid out side by side. */
function maxUnitWidth(): number {
  return (
    Math.max(window.innerWidth, GIANT_PARAGRAPH_SPLIT_MIN_VIEWPORT_PX) *
    GIANT_PARAGRAPH_SPLIT_VIEWPORT_MULTIPLIER
  )
}

/**
 * Whether everything laid out in `box` may be taken in one go when it
 * intersects. Its scroll extent counts in both directions: a short list can
 * hold a long history, and a narrow one a long row.
 */
function layoutFitsSplitCap(box: Element): boolean {
  const rect = box.getBoundingClientRect()
  return (
    layoutExtent(box) <= maxUnitHeight() && Math.max(rect.width, box.scrollWidth) <= maxUnitWidth()
  )
}

/** Owns viewport gates and boxless pending units for one DOM lifetime. */
export class ViewportScheduler {
  private observer: IntersectionObserver | null
  private boxlessUnitObserver: IntersectionObserver | null = null
  private pendingBoxlessUnits = new WeakSet<HTMLElement>()
  constructor(
    private readonly options: IntersectionObserverInit,
    private readonly onVisible: (units: HTMLElement[]) => void,
  ) {
    this.observer = new IntersectionObserver((entries, observer) => {
      const targets: HTMLElement[] = []
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        observer.unobserve(entry.target)
        if (isHTMLElement(entry.target) && !entry.target.closest(`.${CONTENT_WRAPPER_CLASS}`))
          targets.push(entry.target)
      }
      this.onVisible(targets)
    }, options)
  }
  dispose(): void {
    this.observer?.disconnect()
    this.observer = null
    this.boxlessUnitObserver?.disconnect()
    this.boxlessUnitObserver = null
    this.pendingBoxlessUnits = new WeakSet()
  }
  /**
   * Hand one paragraph unit to the viewport gate.
   *
   * A unit with a box is observed directly, as before. A box-less unit
   * (`display: contents`; Telegram web wraps every message in one) can never
   * intersect, so it would never translate. It is gated on boxes instead:
   * preferably the box its content is laid out in, which covers all of it,
   * plain text included; when what that box lays out is larger than a
   * split-sized unit (a long column, a scrolling list or row), the unit's own
   * inner boxes. A unit with neither keeps the direct observation.
   *
   * A unit inside a closed menu is box-less too, but it is observed directly
   * like a rendered one: it intersects once the site shows it. Gating it on a
   * visible ancestor would translate every closed menu on the page up front,
   * ahead of the content on screen.
   */
  observe(unit: HTMLElement): void {
    const observer = this.observer
    if (!observer) return
    if (hasBox(unit) || isInHiddenRegion(unit)) {
      // It may have been box-less when first registered; its old gate must not
      // translate it a second time.
      this.pendingBoxlessUnits.delete(unit)
      observer.observe(unit)
      return
    }
    const layoutBox = findLayoutBox(unit)
    const boxes =
      layoutBox && layoutFitsSplitCap(layoutBox) ? [layoutBox] : collectRenderedBoxes(unit)
    if (boxes.length === 0) {
      observer.observe(unit)
      return
    }
    this.pendingBoxlessUnits.add(unit)
    const boxlessUnitObserver = this.getBoxlessUnitObserver()
    for (const box of boxes) boxlessUnitObserver.observe(box)
  }

  /** Run a pending unit's registration again against the page as it is now. */
  private registerUnitAgain(unit: HTMLElement): void {
    this.observe(unit)
  }

  private getBoxlessUnitObserver(): IntersectionObserver {
    this.boxlessUnitObserver ??= new IntersectionObserver((entries, observer) => {
      const units: HTMLElement[] = []
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        observer.unobserve(entry.target)
        units.push(...this.takePendingUnitsAt(entry.target))
      }
      this.onVisible(units)
    }, this.options)
    return this.boxlessUnitObserver
  }

  private takePendingUnitsAt(box: Element): HTMLElement[] {
    const units: HTMLElement[] = []
    const take = (element: Element) => {
      if (
        isHTMLElement(element) &&
        this.pendingBoxlessUnits.delete(element) &&
        !element.closest(`.${CONTENT_WRAPPER_CLASS}`)
      ) {
        units.push(element)
      }
    }
    for (
      let element = parentElementAcrossShadow(box);
      element;
      element = parentElementAcrossShadow(element)
    ) {
      take(element)
    }
    // Every match, nested ones included: the box is unobserved after this, so a
    // pending unit left inside another one would have nothing left to fire it.
    // Taking them together is only safe while all of it fits a split-sized
    // unit; a box that grew past that since it was chosen (history loaded in
    // while it was off-screen) gives each unit a gate of its own instead.
    if (isHTMLElement(box)) {
      const inside = deepQueryAllSelector(box, (element) => this.pendingBoxlessUnits.has(element))
      if (layoutFitsSplitCap(box)) inside.forEach(take)
      else inside.forEach((unit) => this.registerUnitAgain(unit))
    }
    return units
  }

  /**
   * Removed subtrees are unobserved whether or not they held a pending unit, so
   * virtualized or re-rendered content does not stay observed after it is gone.
   */
  unobserveRemovedGates(record: MutationRecord): void {
    const observer = this.boxlessUnitObserver
    if (!observer) return
    for (const node of record.removedNodes) {
      if (!isHTMLElement(node)) continue
      for (const removed of deepQueryAllSelector(node, () => true)) observer.unobserve(removed)
    }
  }
}

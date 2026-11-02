import {
  CONTENT_WRAPPER_CLASS,
  REACT_SHADOW_HOST_CLASS,
  SPINNER_CLASS,
} from "@/utils/constants/dom-labels"
import {
  wasCharacterDataChangeExtensionDriven,
  wasNodeRemovedByExtension,
} from "../core/translation-state"

export type ContextChangeKind = "source" | "semantic" | "visibility" | "unknown" | "global-style"
function classify(record: MutationRecord): ContextChangeKind {
  if (record.type !== "attributes") return "source"
  if (["hidden", "aria-hidden", "inert", "contenteditable"].includes(record.attributeName!))
    return "visibility"
  if (
    ["role", "itemtype", "itemid", "itemprop", "href", "cite", "rel", "id"].includes(
      record.attributeName!,
    )
  )
    return "semantic"
  if (["class", "style"].includes(record.attributeName!)) return "unknown"
  return "source"
}
type StyleRoot = Document | ShadowRoot
const MAX_STYLE_SHEETS = 128
interface StyleState {
  viewport: string
  count: number
  sheets: {
    reference: WeakRef<CSSStyleSheet>
    disabled: boolean
    media: string
    rules: number | undefined
  }[]
}
function isStyleElement(node: Node | null): node is Element {
  return (
    node instanceof Element &&
    (node.localName === "style" ||
      (node.localName === "link" &&
        (node.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet")))
  )
}
/** The same bounded ancestor/host boundary as source eligibility. */
function styleRoots(node: Node): StyleRoot[] {
  const roots: StyleRoot[] = []
  for (let depth = 0; depth < 64; depth++) {
    const root = node.getRootNode()
    if (root instanceof Document) {
      roots.push(root)
      break
    }
    if (!(root instanceof ShadowRoot)) break
    roots.push(root)
    node = root.host
  }
  return roots
}
interface Registration {
  roots: readonly WeakRef<Node>[]
  changed: (kind: ContextChangeKind) => void
  detached: () => void
}
const UTILITY = `.${CONTENT_WRAPPER_CLASS},.${REACT_SHADOW_HOST_CLASS},.${SPINNER_CLASS}`
function relevant(record: MutationRecord): boolean {
  const target =
    record.target.nodeType === Node.ELEMENT_NODE
      ? (record.target as Element)
      : record.target.parentElement
  if (target?.closest(UTILITY)) return false
  if (record.type === "characterData") return !wasCharacterDataChangeExtensionDriven(record.target)
  if (record.type === "attributes") return true
  const sourceNode = (node: Node) =>
    !wasNodeRemovedByExtension(node) && !(node instanceof Element && node.matches(UTILITY))
  return [...record.addedNodes, ...record.removedNodes].some(sourceNode)
}
/** One shared observer, a weak ancestor index and a bounded registration set.
 * Each snapshot cache entry registers its root and explicit dependencies only. */
export class ContextInvalidationEngine {
  private readonly entries = new Map<string, Registration>()
  private index = new WeakMap<Node, Set<string>>()
  private observer?: MutationObserver
  private observed = new Set<StyleRoot>()
  private readonly styleStates = new Map<StyleRoot, StyleState>()
  private readonly pendingStyles = new Set<StyleRoot>()
  private readonly onStyleCompletion = (event: Event) => {
    if (!isStyleElement(event.target as Node | null)) return
    const root = event.currentTarget as StyleRoot
    if (!this.observed.has(root)) return
    this.metrics.styleCompletions++
    this.pendingStyles.add(root)
  }
  readonly metrics = {
    batches: 0,
    records: 0,
    invalidations: 0,
    processingMs: 0,
    source: 0,
    semantic: 0,
    visibility: 0,
    unknown: 0,
    "global-style": 0,
    styleCompletions: 0,
    styleStateChecks: 0,
    styleSheetReads: 0,
    styleOverflows: 0,
  }
  register(
    id: string,
    roots: readonly Node[],
    changed: (kind: ContextChangeKind) => void,
    detached: () => void,
  ): void {
    this.unregister(id)
    this.entries.set(id, { roots: roots.map((root) => new WeakRef(root)), changed, detached })
    for (const root of roots) {
      const ids = this.index.get(root) ?? new Set<string>()
      ids.add(id)
      this.index.set(root, ids)
      for (const tree of styleRoots(root)) this.observe(tree)
    }
  }
  unregister(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    for (const reference of entry.roots) {
      const root = reference.deref()
      if (root) this.index.get(root)?.delete(id)
    }
    if (!this.entries.size) this.disconnect()
    else this.releaseUnusedRoots()
  }
  private observe(root: StyleRoot, reconnect = false): void {
    if (this.observed.has(root) && !reconnect) return
    if (!this.observed.has(root)) {
      root.addEventListener("load", this.onStyleCompletion, true)
      root.addEventListener("error", this.onStyleCompletion, true)
      this.styleStates.set(root, this.readStyleState(root))
    }
    this.observer ??= new MutationObserver((records) => this.process(records))
    this.observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "href",
        "cite",
        "id",
        "itemid",
        "role",
        "itemtype",
        "rel",
        "hidden",
        "aria-hidden",
        "style",
        "class",
        "contenteditable",
        "aria-label",
        "inert",
        "content",
        "name",
        "property",
        "title",
        "alt",
        "lang",
        "colspan",
        "rowspan",
        "itemprop",
        "media",
        "disabled",
        "type",
      ],
    })
    this.observed.add(root)
  }
  flush(): void {
    this.process(this.observer?.takeRecords() ?? [])
    this.flushStyles()
  }
  private readStyleState(root: StyleRoot): StyleState {
    const ordinary = root.styleSheets ?? []
    const adopted = root.adoptedStyleSheets ?? []
    const count = ordinary.length + adopted.length
    const sheets: StyleState["sheets"] = []
    for (let index = 0; index < Math.min(count, MAX_STYLE_SHEETS); index++) {
      const sheet = index < ordinary.length ? ordinary[index]! : adopted[index - ordinary.length]!
      let rules: number | undefined
      // Cross-origin CSS rules are intentionally opaque. No CSS text/rule tree
      // traversal is needed; a changed top-level count is only a candidate.
      try {
        rules = sheet.cssRules.length
      } catch {
        /* SecurityError */
      }
      sheets.push({
        reference: new WeakRef(sheet),
        disabled: sheet.disabled,
        media: sheet.media?.mediaText ?? "",
        rules,
      })
    }
    this.metrics.styleSheetReads += sheets.length
    const view = root instanceof Document ? root.defaultView : undefined
    return {
      count,
      sheets,
      viewport: view ? `${view.innerWidth}:${view.innerHeight}:${view.devicePixelRatio}` : "",
    }
  }
  /** On demand only. Covers IDL enabled state and sheet attachment before its
   * queued load event, without a timer, DOM scan, or live source projection. */
  checkStyleState(id: string): void {
    const roots = new Set<StyleRoot>()
    for (const reference of this.entries.get(id)?.roots ?? []) {
      const node = reference.deref()
      if (node) for (const tree of styleRoots(node)) roots.add(tree)
    }
    for (const root of roots) {
      if (!this.observed.has(root)) continue
      this.metrics.styleStateChecks++
      const before = this.styleStates.get(root)
      const current = this.readStyleState(root)
      if (current.count > MAX_STYLE_SHEETS) this.metrics.styleOverflows++
      if (
        current.count > MAX_STYLE_SHEETS ||
        !before ||
        before.count !== current.count ||
        before.viewport !== current.viewport ||
        current.sheets.some((sheet, index) => {
          const old = before.sheets[index]
          return (
            !old ||
            old.reference.deref() !== sheet.reference.deref() ||
            old.disabled !== sheet.disabled ||
            old.media !== sheet.media ||
            old.rules !== sheet.rules
          )
        })
      )
        this.pendingStyles.add(root)
      this.styleStates.set(root, current)
    }
    this.flushStyles()
  }
  private addStyleCandidates(root: StyleRoot, affected: Map<string, ContextChangeKind>): void {
    for (const [id, entry] of this.entries)
      if (
        entry.roots.some((reference) => {
          const node = reference.deref()
          if (!node) return false
          return (
            styleRoots(node).includes(root) ||
            (root instanceof ShadowRoot && node.contains(root.host))
          )
        })
      )
        affected.set(id, "global-style")
  }
  private flushStyles(): void {
    if (!this.pendingStyles.size) return
    const affected = new Map<string, ContextChangeKind>()
    for (const root of this.pendingStyles) this.addStyleCandidates(root, affected)
    this.pendingStyles.clear()
    for (const id of affected.keys()) {
      this.entries.get(id)?.changed("global-style")
      this.metrics.invalidations++
      this.metrics["global-style"]++
    }
  }
  private process(records: readonly MutationRecord[]): void {
    if (!records.length) return
    const start = performance.now()
    const affected = new Map<string, ContextChangeKind>()
    const removed = new Set<Node>()
    for (const record of records) {
      if (!relevant(record)) continue
      this.metrics.records++
      const kind = classify(record)
      this.metrics[kind]++
      const target = record.target instanceof Element ? record.target : record.target.parentElement
      // rel can remove stylesheet membership, so classify any link rel edit
      // conservatively without retaining old attribute values for every DOM node.
      const stylesheetAttribute =
        record.type === "attributes" &&
        target?.localName === "link" &&
        (record.attributeName === "rel" ||
          (isStyleElement(target) &&
            ["href", "media", "disabled", "type", "title"].includes(record.attributeName!)))
      if (
        target?.closest("style") ||
        stylesheetAttribute ||
        [...record.addedNodes, ...record.removedNodes].some(isStyleElement)
      ) {
        const tree = record.target.getRootNode()
        if (tree instanceof Document || tree instanceof ShadowRoot) this.pendingStyles.add(tree)
      }
      for (let node: Node | null = record.target; node; node = node.parentNode)
        for (const id of this.index.get(node) ?? []) affected.set(id, kind)
      // Visibility/privacy inherited from an ancestor changes the projection of
      // acquired descendants. Scan only bounded registrations, never its subtree.
      if (record.type === "attributes")
        for (const [id, entry] of this.entries)
          if (
            entry.roots.some((reference) => {
              let root: Node | undefined = reference.deref()
              while (root) {
                if (record.target.contains(root)) return true
                const tree = root.getRootNode()
                root = tree instanceof ShadowRoot ? tree.host : undefined
              }
              return false
            })
          )
            affected.set(id, kind)
      for (const node of record.removedNodes) removed.add(node)
    }
    // Only the bounded set of acquired scopes is checked. Do not walk a removed
    // giant subtree or create entries for its previously untouched descendants.
    if (removed.size)
      for (const [id, entry] of this.entries) {
        const roots = entry.roots.map((reference) => reference.deref())
        const primary = roots[0]
        if (!primary || !primary.isConnected) {
          entry.detached()
          continue
        }
        for (const root of roots)
          if (root) {
            // A move inside the same document retains semantic ownership. Follow a
            // newly attached shadow root but do not mark an unchanged post dirty.
            for (const tree of styleRoots(root)) this.observe(tree)
            if (!root.isConnected || [...removed].some((node) => node.contains(root)))
              affected.set(id, "semantic")
          }
      }
    for (const root of this.pendingStyles) this.addStyleCandidates(root, affected)
    this.pendingStyles.clear()
    for (const [id, kind] of affected) {
      const entry = this.entries.get(id)
      if (entry) {
        entry.changed(kind)
        this.metrics.invalidations++
        if (kind === "global-style") this.metrics["global-style"]++
      }
    }
    this.metrics.batches++
    this.metrics.processingMs += performance.now() - start
    this.releaseUnusedRoots()
  }
  private releaseUnusedRoots(): void {
    const needed = new Set<Document | ShadowRoot>()
    for (const entry of this.entries.values())
      for (const reference of entry.roots) {
        const node = reference.deref()
        if (node) for (const tree of styleRoots(node)) needed.add(tree)
      }
    if ([...this.observed].every((root) => needed.has(root))) return
    const queued = this.observer?.takeRecords() ?? []
    this.observer?.disconnect()
    for (const root of this.observed) if (!needed.has(root)) this.releaseStyleRoot(root)
    for (const root of needed) this.observe(root, true)
    if (queued.length) this.process(queued)
  }
  private releaseStyleRoot(root: StyleRoot): void {
    root.removeEventListener("load", this.onStyleCompletion, true)
    root.removeEventListener("error", this.onStyleCompletion, true)
    this.observed.delete(root)
    this.styleStates.delete(root)
    this.pendingStyles.delete(root)
  }
  private disconnect(): void {
    this.observer?.disconnect()
    this.observer = undefined
    for (const root of this.observed) this.releaseStyleRoot(root)
  }
  clear(): void {
    this.entries.clear()
    this.index = new WeakMap()
    this.disconnect()
  }
  inspect() {
    return {
      registrations: this.entries.size,
      observers: this.observer ? 1 : 0,
      observedRoots: this.observed.size,
      styleListeners: this.observed.size * 2,
      styleStates: this.styleStates.size,
      pendingStyleRoots: this.pendingStyles.size,
      ...this.metrics,
    }
  }
}

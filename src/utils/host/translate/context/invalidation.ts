import {
  CONTENT_WRAPPER_CLASS,
  REACT_SHADOW_HOST_CLASS,
  SPINNER_CLASS,
} from "@/utils/constants/dom-labels"
import {
  wasCharacterDataChangeExtensionDriven,
  wasNodeRemovedByExtension,
} from "../core/translation-state"

interface Registration {
  roots: readonly WeakRef<Node>[]
  changed: () => void
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
  private observed = new Set<Document | ShadowRoot>()
  readonly metrics = { batches: 0, records: 0, invalidations: 0, processingMs: 0 }
  register(id: string, roots: readonly Node[], changed: () => void, detached: () => void): void {
    this.unregister(id)
    this.entries.set(id, { roots: roots.map((root) => new WeakRef(root)), changed, detached })
    for (const root of roots) {
      const ids = this.index.get(root) ?? new Set<string>()
      ids.add(id)
      this.index.set(root, ids)
      const tree = root.getRootNode()
      if (tree instanceof Document || tree instanceof ShadowRoot) {
        this.observe(tree)
        if (tree instanceof ShadowRoot) this.observe(tree.ownerDocument)
      }
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
  private observe(root: Document | ShadowRoot): void {
    if (this.observed.has(root)) return
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
      ],
    })
    this.observed.add(root)
  }
  flush(): void {
    this.process(this.observer?.takeRecords() ?? [])
  }
  private process(records: readonly MutationRecord[]): void {
    if (!records.length) return
    const start = performance.now()
    const affected = new Set<string>()
    const removed = new Set<Node>()
    for (const record of records) {
      if (!relevant(record)) continue
      this.metrics.records++
      for (let node: Node | null = record.target; node; node = node.parentNode)
        for (const id of this.index.get(node) ?? []) affected.add(id)
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
            affected.add(id)
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
            const tree = root.getRootNode()
            if (tree instanceof Document || tree instanceof ShadowRoot) this.observe(tree)
            if (
              !root.isConnected ||
              [...removed].some((node) => node.contains(root) && !node.isConnected)
            )
              affected.add(id)
          }
      }
    for (const id of affected) {
      const entry = this.entries.get(id)
      if (entry) {
        entry.changed()
        this.metrics.invalidations++
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
        const tree = reference.deref()?.getRootNode()
        if (tree instanceof Document || tree instanceof ShadowRoot) {
          needed.add(tree)
          if (tree instanceof ShadowRoot) needed.add(tree.ownerDocument)
        }
      }
    if ([...this.observed].every((root) => needed.has(root))) return
    const queued = this.observer?.takeRecords() ?? []
    this.observer?.disconnect()
    this.observed.clear()
    for (const root of needed) this.observe(root)
    if (queued.length) this.process(queued)
  }
  private disconnect(): void {
    this.observer?.disconnect()
    this.observer = undefined
    this.observed.clear()
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
      ...this.metrics,
    }
  }
}

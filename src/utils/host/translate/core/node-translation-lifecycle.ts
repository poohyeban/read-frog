import { getPageTranslationSessionId } from "../translation-session"

interface TrackedUnit {
  source: Node
  isCurrent: () => boolean
  dispose: () => void
  canHandOffToPage?: () => boolean
}

interface NodeTranslation {
  root: HTMLElement
  active: boolean
  pending: boolean
  units: Set<TrackedUnit>
}

// Only explicit node translations enter this registry. Page translation keeps
// its own mutation/retranslation policy; hover translations expire without
// automatically sending another API request.
const translations = new Map<string, NodeTranslation>()
let observer: MutationObserver | undefined
const observedRoots = new Set<Document | ShadowRoot>()

function containsComposed(ancestor: Node, node: Node): boolean {
  if (ancestor.contains(node)) return true
  const root = node.getRootNode()
  return root instanceof ShadowRoot && containsComposed(ancestor, root.host)
}

function observeSource(source: Node): void {
  let root = source.getRootNode()
  while (root instanceof Document || root instanceof ShadowRoot) {
    if (!observedRoots.has(root)) {
      observedRoots.add(root)
      observer?.observe(root, { childList: true, characterData: true, subtree: true })
    }
    if (root instanceof Document) break
    root = root.host.getRootNode()
  }
}

function releaseUnusedObservers(): void {
  // Rebuild only when a scope ends, so detached shadow roots are not retained
  // by a long-lived observer. Ordinary mutations never rescan the document.
  const pendingRecords = observer?.takeRecords()
  observer?.disconnect()
  observedRoots.clear()
  if (translations.size === 0) {
    observer = undefined
    return
  }
  for (const translation of translations.values()) {
    observeSource(translation.root)
    for (const unit of translation.units) observeSource(unit.source)
  }
  // Disconnect discards queued records, including changes made by a cleanup
  // above to another tracked unit. Deliver those before forgetting the roots.
  if (pendingRecords?.length) queueMicrotask(() => reconcile(pendingRecords))
}

function reconcile(records?: MutationRecord[]): void {
  let released = false
  for (const [walkId, translation] of translations) {
    const connected = translation.root.isConnected
    if (!connected) translation.active = false
    for (const unit of translation.units) {
      const affected =
        !connected ||
        !unit.source.isConnected ||
        !records ||
        records.some(
          (record) =>
            containsComposed(unit.source, record.target) ||
            [...record.removedNodes].some((node) => containsComposed(node, unit.source)),
        )
      if (!affected) continue
      // Frameworks can move a still-valid node into another shadow tree. Keep
      // following that source instead of leaving the observer on its old root.
      if (unit.source.isConnected) observeSource(unit.source)
      if (translation.active && unit.isCurrent()) continue
      translation.units.delete(unit)
      // Leave the registered stale source intact for the page observer. Its
      // asynchronous traversal must still see the state, regardless of which
      // observer was created first. Ownership then belongs to the page walk.
      if (!(connected && getPageTranslationSessionId() && unit.canHandOffToPage?.())) {
        unit.dispose()
      }
    }
    if ((!translation.pending || !translation.active) && translation.units.size === 0) {
      translation.active = false
      translations.delete(walkId)
      released = true
    }
  }
  if (released) releaseUnusedObservers()
}

export function beginNodeTranslation(root: HTMLElement, walkId: string) {
  const translation: NodeTranslation = { root, active: true, pending: true, units: new Set() }
  translations.set(walkId, translation)
  observer ??= new MutationObserver(reconcile)
  observeSource(root)
  return {
    isActive: () => translation.active && root.isConnected,
    finish: () => {
      translation.pending = false
      reconcile()
    },
  }
}

export function getNodeTranslation(walkId: string): NodeTranslation | undefined {
  return translations.get(walkId)
}

export function trackNodeTranslation(walkId: string, unit: TrackedUnit): void {
  const translation = translations.get(walkId)
  if (!translation) return
  if (!translation.active) {
    unit.dispose()
    return
  }
  translation.units.add(unit)
  observeSource(unit.source)
}

/** Called when the content runtime is torn down, including extension updates. */
export function cleanupNodeTranslations(): void {
  for (const translation of translations.values()) {
    translation.active = false
    for (const unit of translation.units) unit.dispose()
    translation.units.clear()
  }
  translations.clear()
  releaseUnusedObservers()
}

/** Owns native observers and registration deduplication for one DOM lifetime. */
export class DOMObservation {
  private roots = new Map<HTMLElement, MutationObserver>()
  observe(
    root: HTMLElement,
    receive: (records: MutationRecord[], root: HTMLElement) => void,
  ): void {
    this.prune()
    if (this.roots.has(root)) return
    const observer = new MutationObserver((records) => {
      this.prune()
      receive(records, root)
    })
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "aria-hidden"],
    })
    this.roots.set(root, observer)
  }
  private prune(): void {
    for (const [root, observer] of this.roots) {
      if (root.isConnected) continue
      observer.disconnect()
      this.roots.delete(root)
    }
  }
  dispose(): void {
    for (const observer of this.roots.values()) observer.disconnect()
    this.roots.clear()
  }
}

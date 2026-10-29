/** Collapse duplicate/descendant scan roots without scanning each subtree. */
export function coalesceScanRoots(roots: Iterable<HTMLElement>): HTMLElement[] {
  const pending = new Set(roots)
  return [...pending].filter((element) => {
    if (!element.isConnected) return false
    let node: Node = element
    while (true) {
      const parent = node.parentNode
      if (!parent) return true
      if (parent instanceof HTMLElement && pending.has(parent)) return false
      node = parent instanceof ShadowRoot ? parent.host : parent
      if (node instanceof HTMLElement && node !== element && pending.has(node)) return false
    }
  })
}

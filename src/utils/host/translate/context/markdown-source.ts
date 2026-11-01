/** Defuddle operates on an already bounded source projection. Bound its output
 * again before markdown conversion; flatten nested tables to avoid exponential
 * table expansion in the converter. */
export function prepareContextMarkdownSource(html: string, budget: number): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  let remaining = budget
  const trim = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (remaining <= 0) {
        child.remove()
        continue
      }
      if (child.nodeType === Node.TEXT_NODE) {
        child.textContent = (child.textContent ?? "").slice(0, remaining)
        remaining -= child.textContent.length
      } else trim(child)
    }
  }
  trim(doc.body)
  for (const table of [...doc.querySelectorAll<HTMLTableElement>("table table")]) {
    const block = doc.createElement("div")
    if (table.caption) block.append(...table.caption.childNodes)
    for (const row of [...table.rows])
      for (const cell of [...row.cells]) {
        const value = doc.createElement("div")
        value.append(...cell.childNodes)
        block.append(value)
      }
    table.replaceWith(block)
  }
  return doc.body.innerHTML
}

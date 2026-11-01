/** Fragment jumps stay in the document; hash routers do not. */
export function isInPageAnchorChange(from: string, to: string, doc: Document = document): boolean {
  const split = (url: string) => {
    const index = url.indexOf("#")
    return index < 0 ? [url, ""] : [url.slice(0, index), url.slice(index + 1)]
  }
  const [fromBase, fromHash] = split(from)
  const [toBase, toHash] = split(to)
  const anchor = (hash: string | undefined) => {
    if (!hash || hash.toLowerCase() === "top") return true
    let decoded = hash
    try {
      decoded = decodeURIComponent(hash)
    } catch {
      /* use literal fragment */
    }
    return [hash, decoded].some(
      (id) =>
        doc.getElementById(id) ||
        [...doc.getElementsByName(id)].some((node) => node.localName === "a"),
    )
  }
  return fromBase === toBase && anchor(fromHash) && anchor(toHash)
}

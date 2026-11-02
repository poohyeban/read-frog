/** Shared instrumentation for the fixed V2 baseline and hardened sources. */
export function installAttributeBenchmark(context, messages) {
  const counts = { style: 0, attributes: 0, text: 0, children: 0, clones: 0 }
  const style = window.getComputedStyle
  window.getComputedStyle = function (...args) {
    counts.style++
    return style.apply(this, args)
  }
  // Captured methods are deliberately rebound with apply below.
  // eslint-disable-next-line typescript/unbound-method
  const attribute = Element.prototype.getAttribute
  Element.prototype.getAttribute = function (...args) {
    counts.attributes++
    return attribute.apply(this, args)
  }
  // eslint-disable-next-line typescript/unbound-method
  const clone = Node.prototype.cloneNode
  Node.prototype.cloneNode = function (...args) {
    counts.clones++
    return clone.apply(this, args)
  }
  for (const [name, key] of [
    ["textContent", "text"],
    ["childNodes", "children"],
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, name)
    Object.defineProperty(Node.prototype, name, {
      ...descriptor,
      get() {
        counts[key]++
        return descriptor.get.call(this)
      },
    })
  }
  window.sourceReadCounts = counts
  window.attributeBench = async (scenario) => {
    context.releaseWebPageContext()
    document.body.innerHTML =
      '<main role="feed">' +
      Array.from(
        { length: 100 },
        (_, index) =>
          `<article id="post-${index}"><h2>Heading ${index}</h2><p>Original source ${index}</p></article>`,
      ).join("") +
      "</main>"
    const source = document.getElementById("post-0"),
      other = document.getElementById("post-1")
    const read = () => context.getOrCreateWebPageContext(true, undefined, { source })
    const first = await read()
    const initial = context.getContextDiagnostics()
    const beforeReads = { ...counts }
    const beforeRPCs = messages.summaryMessages
    const beforeTranslations = messages.translations
    const reads = [],
      invalidations = [],
      resolves = []
    let stale = 0,
      reused = 0
    for (let index = 0; index < 1000; index++) {
      if (scenario === "class") source.className = index % 2 ? "hover-highlight" : "animation-frame"
      if (scenario === "style")
        source.style.cssText = `color:rgb(${index % 255},0,0);border:1px solid red;font-weight:${index % 2 ? 700 : 400};transform:translateY(${index}px)`
      if (scenario === "text" || scenario === "recycle")
        source.querySelector("p").textContent = `Updated source ${index}`
      if (scenario === "recycle") source.setAttribute("itemid", `/posts/${index}`)
      if (scenario === "unrelated") {
        other.querySelector("p").textContent = `Other ${index}`
        other.className = `decor-${index}`
      }
      if (scenario === "move") source.parentElement.append(source)
      if (scenario === "privacy") source.style.opacity = index % 2 ? "1" : "0"
      let start = performance.now()
      context.synchronizeWebPageContext()
      invalidations.push(performance.now() - start)
      start = performance.now()
      context.resolveContextScope({ source })
      resolves.push(performance.now() - start)
      start = performance.now()
      try {
        if ((await read()) === first) reused++
      } catch (error) {
        if (error?.code !== "CONTEXT_STALE") throw error
        stale++
      }
      reads.push(performance.now() - start)
    }
    const end = context.getContextDiagnostics()
    context.releaseWebPageContext()
    return {
      scenario,
      iterations: 1000,
      reads,
      invalidations,
      resolves,
      stale,
      reused,
      metrics: Object.fromEntries(
        [
          "projections",
          "metadataProjections",
          "rebuilds",
          "hits",
          "visitedNodes",
          "validations",
          "validationNodes",
        ].map((key) => [key, (end[key] ?? 0) - (initial[key] ?? 0)]),
      ),
      sourceReads: Object.fromEntries(
        Object.keys(counts).map((key) => [key, counts[key] - beforeReads[key]]),
      ),
      after: context.getContextDiagnostics(),
      summaryRPC: messages.summaryMessages - beforeRPCs,
      translationRPC: messages.translations - beforeTranslations,
    }
  }
}

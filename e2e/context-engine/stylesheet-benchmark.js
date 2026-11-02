/** Local browser instrumentation only. Both revisions use this exact fixture. */
export function installStylesheetBenchmark(context, messages, promptCurrent) {
  window.stylesheetBench = async (scenario) => {
    context.releaseWebPageContext()
    const counts = window.sourceReadCounts
    const sheetCount =
      scenario === "warm-128-sheets" ? 128 : scenario === "overflow-130-sheets" ? 130 : 1
    for (let i = 0; i < sheetCount; i++) {
      const style = document.createElement("style")
      style.textContent = `.unused-${i}{color:blue}`
      document.head.append(style)
    }
    const scopeCount = scenario === "coalesced-128-scopes" ? 128 : 1
    const body =
      scenario === "prompt-bounded"
        ? Array.from({ length: 1100 }, () => "<span>x</span>").join("")
        : "<p>Visible original English text</p>"
    document.body.innerHTML =
      '<main role="feed">' +
      Array.from(
        { length: scopeCount },
        (_, i) => `<article id="post-${i}"><h2>Safe title</h2>${body}</article>`,
      ).join("") +
      "</main>"
    const sources = [...document.querySelectorAll("article")]
    const read = (source) => context.getOrCreateWebPageContext(true, undefined, { source })
    const first = await read(sources[0])
    for (const source of sources.slice(1)) await read(source)
    const initial = context.getContextDiagnostics()
    const beforeReads = { ...counts }
    const beforeRPCs = { summary: messages.summaryMessages, translation: messages.translations }
    const durations = []
    let unchanged = 0
    let candidatesOnly
    const style = document.querySelector("style")
    if (scenario === "coalesced-128-scopes") {
      const start = performance.now()
      for (let i = 0; i < 1000; i++) style.dispatchEvent(new Event("load"))
      context.synchronizeWebPageContext()
      durations.push(performance.now() - start)
      candidatesOnly = context.getContextDiagnostics()
      if ((await read(sources[0])) === first) unchanged++
    } else {
      for (let i = 0; i < 1000; i++) {
        if (scenario === "cosmetic-style") style.textContent = `.unused{color:rgb(${i % 255},0,0)}`
        const start = performance.now()
        if (scenario.startsWith("prompt-")) {
          if (promptCurrent?.(first) !== false) unchanged++
        } else if ((await read(sources[0])) === first) unchanged++
        durations.push(performance.now() - start)
      }
    }
    const end = context.getContextDiagnostics()
    context.releaseWebPageContext()
    return {
      scenario,
      sheetCount,
      scopeCount,
      iterations: 1000,
      durations,
      unchanged,
      guardAvailable: !!promptCurrent,
      initial,
      candidatesOnly,
      end,
      after: context.getContextDiagnostics(),
      sourceReads: Object.fromEntries(
        Object.keys(counts).map((key) => [key, counts[key] - beforeReads[key]]),
      ),
      summaryRPC: messages.summaryMessages - beforeRPCs.summary,
      translationRPC: messages.translations - beforeRPCs.translation,
      notes: scenario.startsWith("prompt-")
        ? "Direct bounded dispatch-validator cost; baseline has no guard. No model requests."
        : "Synthetic load events or real DOM stylesheet state; no external CSS requests.",
    }
  }
}

// @vitest-environment jsdom
import { expect, it } from "vitest"
import { coalesceScanRoots } from "@/utils/host/dom/scan-roots"
import { percentiles, report } from "./report"

it("records duplicate mutation traversal work on a 5,000-paragraph document", async () => {
  const host = document.createElement("main")
  const roots: HTMLElement[] = []
  for (let group = 0; group < 250; group++) {
    const section = document.createElement("section")
    roots.push(section)
    for (let item = 0; item < 20; item++) {
      const paragraph = document.createElement("p")
      paragraph.textContent = `Paragraph ${group * 20 + item}`
      section.append(paragraph)
      roots.push(paragraph, paragraph, paragraph)
    }
    host.append(section)
  }
  document.body.append(host)
  const visit = (items: Iterable<HTMLElement>) => {
    let count = 0
    for (const root of items) {
      count++
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
      while (walker.nextNode()) count++
    }
    return count
  }
  const samples: { originalMs: number; coalescedMs: number }[] = []
  let beforeVisits = 0
  let afterVisits = 0
  try {
    for (let round = -3; round < 30; round++) {
      let originalMs = 0
      let coalescedMs = 0
      const original = () => {
        const start = performance.now()
        beforeVisits = visit(roots)
        originalMs = performance.now() - start
      }
      const coalesced = () => {
        const start = performance.now()
        afterVisits = visit(coalesceScanRoots(roots))
        coalescedMs = performance.now() - start
      }
      if (round % 2) {
        original()
        coalesced()
      } else {
        coalesced()
        original()
      }
      if (round >= 0) samples.push({ originalMs, coalescedMs })
    }
    expect(afterVisits).toBe(5250)
    expect(beforeVisits).toBe(20250)
    await report("dom-roots", {
      workload: "5,000 paragraphs; section insert plus repeated child mutation roots",
      caveat:
        "JSDOM traversal only; excludes style/layout, observer delivery, translation and browser long tasks",
      beforeVisits,
      afterVisits,
      originalMs: percentiles(samples.map((s) => s.originalMs)),
      coalescedMs: percentiles(samples.map((s) => s.coalescedMs)),
      samples,
    })
  } finally {
    host.remove()
  }
})

// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest"
import { coalesceScanRoots } from "../scan-roots"

afterEach(() => {
  document.body.replaceChildren()
})
it("coalesces parent/child additions in any arrival order, including Shadow DOM", () => {
  const parent = document.createElement("section")
  const host = document.createElement("div")
  const child = document.createElement("p")
  host.attachShadow({ mode: "open" }).append(child)
  parent.append(host)
  document.body.append(parent)
  expect(coalesceScanRoots([child, host, parent, parent])).toEqual([parent])
  expect(coalesceScanRoots([parent, child, host])).toEqual([parent])
  parent.remove()
  expect(coalesceScanRoots([parent, child])).toEqual([])
})
it("does not merge independent siblings or scan detached additions", () => {
  const nodes = Array.from({ length: 5000 }, () => document.createElement("p"))
  document.body.append(...nodes)
  expect(coalesceScanRoots(nodes)).toEqual(nodes)
  expect(coalesceScanRoots([...nodes, document.body])).toEqual([document.body])
  expect(coalesceScanRoots([document.createElement("p")])).toEqual([])
})

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { releaseDocumentIdentity } from "../document-lifetime"
import { ContextSnapshotManager } from "../snapshot-manager"
import { FULL_CONTEXT } from "../types"

const hooks = vi.hoisted(() => ({ convert: vi.fn<() => void>() }))
vi.mock("defuddle/full", () => ({
  default: class {
    constructor(private doc: Document) {}
    parse() {
      return { content: this.doc.body.innerHTML }
    }
  },
  createMarkdownContent: (html: string) => {
    hooks.convert()
    return new DOMParser().parseFromString(html, "text/html").body.textContent ?? ""
  },
}))
let manager: ContextSnapshotManager
let source: HTMLElement
let hidden: boolean
const read = () => manager.read({ source }, FULL_CONTEXT)
beforeEach(() => {
  releaseDocumentIdentity()
  manager = new ContextSnapshotManager(8)
  hidden = false
  hooks.convert.mockReset()
  document.head.innerHTML =
    '<link id="css" rel="stylesheet" href="/visible.css"><style id="inline">article { color: black }</style>'
  document.body.innerHTML =
    '<main role="feed"><article id="a"><h2>A title</h2><p>PRIVATE_AFTER_HIDE</p></article><article id="b"><p>Unrelated source</p></article></main>'
  source = document.querySelector<HTMLElement>("#a")!
  // jsdom does not load external styles. Only the style result changes; no local
  // source mutation can accidentally manufacture the invalidation under test.
  const native = window.getComputedStyle.bind(window)
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const result = native(element, pseudo)
    return new Proxy(result, {
      get: (target, property) =>
        property === "display" && element === source && hidden
          ? "none"
          : Reflect.get(target, property, target),
    })
  })
})
afterEach(() => {
  manager.clear()
  releaseDocumentIdentity()
  vi.restoreAllMocks()
})

it.each([
  ["href", "/hidden.css"],
  ["rel", "icon"],
  ["media", "print"],
  ["disabled", ""],
  ["type", "text/plain"],
])(
  "stylesheet link %s change validates the actual source on next demand",
  async (attribute, value) => {
    const before = await read(),
      other = await manager.read({ source: document.querySelector("#b") }, FULL_CONTEXT)
    hidden = true
    document.querySelector("#css")!.setAttribute(attribute, value)
    manager.invalidation.flush()
    expect(manager.inspect().projections).toBe(2)
    expect((await read()).webContent).not.toContain("PRIVATE_AFTER_HIDE")
    expect(await manager.read({ source: document.querySelector("#b") }, FULL_CONTEXT)).toBe(other)
    expect(before.webContent).toContain("PRIVATE_AFTER_HIDE")
  },
)
it("rel transition from non-style to case-insensitive alternate stylesheet is observed", async () => {
  document.querySelector("#css")!.setAttribute("rel", "preload")
  await read()
  hidden = true
  document.querySelector("#css")!.setAttribute("rel", "alternate StyleSheet")
  expect((await read()).webContent).not.toContain("PRIVATE_AFTER_HIDE")
})
it("style media changes invalidate a cached feed scope", async () => {
  await read()
  hidden = true
  document.querySelector("#inline")!.setAttribute("media", "print")
  expect((await read()).webContent).not.toContain("PRIVATE_AFTER_HIDE")
})
it("load after an intervening old-style cache read validates again", async () => {
  const initial = await read()
  document.querySelector("#css")!.setAttribute("href", "/delayed.css")
  expect(await read()).toBe(initial)
  const projections = manager.inspect().projections
  hidden = true
  document.querySelector("#css")!.dispatchEvent(new Event("load"))
  expect(manager.inspect().projections).toBe(projections)
  expect((await read()).webContent).not.toContain("PRIVATE_AFTER_HIDE")
  expect(initial.webContent).toContain("PRIVATE_AFTER_HIDE")
})
it("stylesheet error and inline import load are completion signals, not model work", async () => {
  hidden = true
  await read()
  hidden = false
  document.querySelector("#css")!.dispatchEvent(new Event("error"))
  expect((await read()).webContent).toContain("PRIVATE_AFTER_HIDE")
  hidden = true
  document.querySelector("#inline")!.dispatchEvent(new Event("load"))
  expect((await read()).webContent).not.toContain("PRIVATE_AFTER_HIDE")
})
it("style text and link insert/remove preserve existing observable invalidation", async () => {
  await read()
  hidden = true
  document.querySelector("#inline")!.textContent = "article { color:blue }"
  expect((await read()).webContent).not.toContain("PRIVATE_AFTER_HIDE")
  hidden = false
  document.querySelector("#css")!.remove()
  expect((await read()).webContent).toContain("PRIVATE_AFTER_HIDE")
  hidden = true
  document.head.insertAdjacentHTML("beforeend", '<link rel="stylesheet" href="/new.css">')
  expect((await read()).webContent).not.toContain("PRIVATE_AFTER_HIDE")
})
it("1000 completion events coalesce and cosmetic CSS reuses the snapshot", async () => {
  const first = await read()
  const before = manager.inspect().invalidation.invalidations
  for (let i = 0; i < 1000; i++) document.querySelector("#css")!.dispatchEvent(new Event("load"))
  manager.invalidation.flush()
  expect(manager.inspect().invalidation.invalidations - before).toBe(1)
  expect(await read()).toBe(first)
  expect(manager.inspect()).toMatchObject({ projections: 1, rebuilds: 1, stalePreparations: 0 })
})
it("a style completion during asynchronous preparation cannot publish visible old source", async () => {
  hooks.convert.mockImplementationOnce(() => {
    hidden = true
    document.querySelector("#css")!.dispatchEvent(new Event("load"))
  })
  expect((await read()).webContent).not.toContain("PRIVATE_AFTER_HIDE")
  expect(manager.inspect().stalePreparations).toBe(1)
})
it("shadow-local completion affects its acquired subtree, not a sibling shadow tree", async () => {
  const make = () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = host.attachShadow({ mode: "open" })
    root.innerHTML =
      '<link rel="stylesheet" href="/shadow.css"><article><p>PRIVATE_AFTER_HIDE</p></article>'
    return root
  }
  const left = make(),
    right = make()
  source = left.querySelector("article")!
  await read()
  const unrelated = await manager.read({ source: right.querySelector("article") }, FULL_CONTEXT)
  const before = manager.inspect().invalidation.invalidations
  hidden = true
  left.querySelector("link")!.dispatchEvent(new Event("load"))
  manager.invalidation.flush()
  expect(manager.inspect().invalidation.invalidations - before).toBe(1)
  expect(await manager.read({ source: right.querySelector("article") }, FULL_CONTEXT)).toBe(
    unrelated,
  )
  expect((await read()).webContent).not.toContain("PRIVATE_AFTER_HIDE")
})
it("document stylesheet completion reaches an acquired nested open shadow scope", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const outer = host.attachShadow({ mode: "open" })
  outer.innerHTML = "<div></div><style></style>"
  const inner = outer.querySelector("div")!.attachShadow({ mode: "open" })
  inner.innerHTML = "<article><p>PRIVATE_AFTER_HIDE</p></article>"
  source = inner.querySelector("article")!
  await read()
  hidden = true
  document.querySelector("#css")!.dispatchEvent(new Event("load"))
  expect((await read()).webContent).not.toContain("PRIVATE_AFTER_HIDE")
  hidden = false
  outer.querySelector("style")!.dispatchEvent(new Event("load"))
  expect((await read()).webContent).toContain("PRIVATE_AFTER_HIDE")
})
it("released managers do not retain or react to stylesheet listeners", async () => {
  const add = vi.spyOn(document, "addEventListener"),
    remove = vi.spyOn(document, "removeEventListener")
  for (let i = 0; i < 100; i++) {
    await read()
    manager.clear()
  }
  const installed = add.mock.calls.filter(([name]) => name === "load" || name === "error")
  const released = remove.mock.calls.filter(([name]) => name === "load" || name === "error")
  expect(installed).toHaveLength(200)
  expect(released).toHaveLength(installed.length)
  for (const [type, handler, capture] of installed)
    expect(
      released.some((call) => call[0] === type && call[1] === handler && call[2] === capture),
    ).toBe(true)
  const before = manager.inspect()
  document.querySelector("#css")!.dispatchEvent(new Event("load"))
  await Promise.resolve()
  expect(manager.inspect()).toEqual(before)
  expect(before).toMatchObject({ scopes: 0, activeExtractions: 0, invalidation: { observers: 0 } })
})
it("effective sheet disabled changes without an attribute cannot leave a hot snapshot valid", async () => {
  await read()
  const sheet = document.querySelector<HTMLStyleElement>("#inline")!.sheet!
  sheet.disabled = true
  hidden = true
  expect((await read()).webContent).not.toContain("PRIVATE_AFTER_HIDE")
})

it("128 acquired scopes share two document listeners and remain lazy after a global event", async () => {
  manager.clear()
  manager = new ContextSnapshotManager(128)
  document.body.innerHTML =
    '<main role="feed">' +
    Array.from(
      { length: 128 },
      (_, index) => `<article id="scope-${index}"><p>Source ${index}</p></article>`,
    ).join("") +
    "</main>"
  source = document.querySelector<HTMLElement>("#scope-0")!
  for (const node of document.querySelectorAll("article"))
    await manager.read({ source: node }, FULL_CONTEXT)
  const before = manager.inspect()
  document.querySelector("#css")!.dispatchEvent(new Event("load"))
  manager.invalidation.flush()
  expect(manager.inspect()).toMatchObject({
    projections: before.projections,
    rebuilds: before.rebuilds,
    invalidation: { observers: 1, styleListeners: 2 },
  })
  hidden = true
  expect((await read()).webContent).toBe("")
  expect(manager.inspect().projections).toBe(before.projections + 1)
  manager.clear()
  expect(manager.inspect().invalidation).toMatchObject({
    styleListeners: 0,
    styleStates: 0,
    pendingStyleRoots: 0,
  })
}, 15_000)
it("stylesheet inventory overflow uses bounded demand validation instead of a stale cache hit", async () => {
  for (let index = 0; index < 129; index++) {
    const style = document.createElement("style")
    style.textContent = `p {color:rgb(${index},0,0)}`
    document.head.append(style)
  }
  await read()
  const before = manager.inspect().invalidation.styleSheetReads
  hidden = true
  expect((await read()).webContent).not.toContain("PRIVATE_AFTER_HIDE")
  // One cache validation plus one extraction publication, each capped at 128.
  expect(manager.inspect().invalidation.styleSheetReads - before).toBeLessThanOrEqual(256)
  expect(manager.inspect().invalidation.styleOverflows).toBeGreaterThan(0)
})

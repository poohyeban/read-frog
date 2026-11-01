// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { REACT_SHADOW_HOST_CLASS } from "@/utils/constants/dom-labels"
import { projectSourceRegion } from "../../source-document"
import { releaseDocumentIdentity } from "../document-lifetime"
import { resolveContextScope } from "../scope-resolver"
import { ContextSnapshotManager } from "../snapshot-manager"
import { FULL_CONTEXT, NO_CONTEXT } from "../types"

const hooks = vi.hoisted(() => ({ convert: vi.fn<() => void>() }))
vi.mock("defuddle/full", () => ({
  default: class {
    constructor(private source: Document) {}
    parse() {
      return { content: this.source.body.innerHTML }
    }
  },
  createMarkdownContent: (html: string) => {
    hooks.convert()
    const doc = new DOMParser().parseFromString(html, "text/html")
    doc.querySelectorAll(".parser-omit").forEach((node) => node.remove())
    return (
      (doc.body.textContent ?? "") +
      [...doc.querySelectorAll("a")].map((a) => a.getAttribute("href")).join("")
    )
  },
}))
let manager: ContextSnapshotManager
const node = (id: string) => document.getElementById(id)!
const read = (id = "a") => manager.read({ source: node(id) }, FULL_CONTEXT)
beforeEach(() => {
  releaseDocumentIdentity()
  manager = new ContextSnapshotManager(8)
  hooks.convert.mockReset()
  document.head.innerHTML =
    '<title>Document title</title><meta name="description" content="Document description"><style>.concealed { display:none } .hover {color:red} .bold {font-weight:700}</style>'
  document.body.innerHTML =
    '<main id="feed" role="feed"><article id="a"><h2>A heading</h2><p>A source</p><a href="/first">Source link</a></article><article id="b"><h2>B heading</h2><p>B source</p></article></main><main id="standalone"></main>'
})
afterEach(() => {
  manager.clear()
  releaseDocumentIdentity()
  vi.restoreAllMocks()
})

it.each(["hover", "bold", "animation-frame-1"])(
  "P0-1: presentation class %s preserves the snapshot without projection",
  async (className) => {
    const first = await read()
    const projections = manager.inspect().projections
    node("a").classList.add(className)
    expect(await read()).toBe(first)
    expect(manager.inspect().projections).toBe(projections)
    expect(manager.inspect().rebuilds).toBe(1)
  },
)
it("P0-1: 1000 decorative style changes never cause a projection or stale preparation", async () => {
  const first = await read()
  const projections = manager.inspect().projections
  for (let index = 0; index < 1000; index++) {
    node("a").style.cssText =
      `color:rgb(${index % 255},0,0);border:1px solid red;font-weight:${index % 2 ? 700 : 400};transform:translateY(${index}px)`
    expect(await read()).toBe(first)
  }
  expect(manager.inspect()).toMatchObject({ projections, rebuilds: 1, stalePreparations: 0 })
}, 30_000)
it("P0-1: presentation changes during parsing do not restart preparation", async () => {
  hooks.convert.mockImplementation(() => node("a").classList.toggle("hover"))
  const value = await read()
  expect(value.webContent).toContain("A source")
  expect(manager.inspect()).toMatchObject({ projections: 1, rebuilds: 1, stalePreparations: 0 })
})
it("P0-1: real text changes during parsing cannot publish old content", async () => {
  hooks.convert.mockImplementationOnce(() => {
    node("a").querySelector("p")!.textContent = "Changed during parse"
  })
  expect((await read()).webContent).toContain("Changed during parse")
  expect(manager.inspect().stalePreparations).toBe(1)
})
it("P0-1: a used meta content attribute expires only its actual consumer", async () => {
  node("standalone").append(node("a"))
  const first = await read()
  const b = await read("b")
  document.querySelector("meta")!.setAttribute("content", "Changed description")
  expect((await read()).webDescription).toBe("Changed description")
  expect((await read()).identity).not.toBe(first.identity)
  expect(await read("b")).toBe(b)
})
it("P0-1: unused body changes do not rebuild metadata-only context", async () => {
  const requirements = { ...NO_CONTEXT, title: true }
  const first = await manager.read({ source: node("a") }, requirements)
  node("a").querySelector("p")!.textContent = "Not used by this prompt"
  expect(await manager.read({ source: node("a") }, requirements)).toBe(first)
  expect(manager.inspect().rebuilds).toBe(1)
})
it("P0-1: CSS visibility changes hide and restore source without affecting unrelated scope", async () => {
  const a = await read(),
    b = await read("b")
  node("a").className = "concealed"
  expect((await read()).webContent).not.toContain("A source")
  expect(await read("b")).toBe(b)
  node("a").className = "hover"
  expect((await read()).identity).toBe(a.identity)
})
it("P0-1: links, source replacement and heading changes refresh the actual data", async () => {
  const first = await read()
  node("a").querySelector("a")!.setAttribute("href", "/second")
  expect((await read()).webContent).toContain("/second")
  node("a").querySelector("p")!.outerHTML = "<p>Replacement source</p>"
  expect((await read()).webContent).toContain("Replacement source")
  node("a").querySelector("h2")!.textContent = "New heading"
  expect((await read()).webTitle).toBe("New heading")
  expect((await read()).identity).not.toBe(first.identity)
})
it("P0-1: unrelated 1000 mutations and source reorder preserve the existing snapshot", async () => {
  const first = await read()
  for (let i = 0; i < 1000; i++) {
    node("b").className = `decor-${i}`
    node("b").querySelector("p")!.textContent = `Other source ${i}`
  }
  node("feed").append(node("a"))
  expect(await read()).toBe(first)
  expect(manager.inspect().projections).toBe(1)
})
it("P0-2: collection affinity ends when a feed item becomes a standalone article", async () => {
  const first = await read()
  node("standalone").append(node("a"))
  const scope = resolveContextScope({ source: node("a") })
  expect(scope).toMatchObject({ type: "Article", collection: false, confidence: "semantic" })
  const next = await read()
  expect(next.webDescription).toBe("Document description")
  expect(next.identity).not.toBe(first.identity)
  node("feed").append(node("a"))
  expect(resolveContextScope({ source: node("a") }).collection).toBe(true)
  expect((await read()).webDescription).toBe("")
})
it("P0-2: last generic repeated item retains only its current container affiliation", async () => {
  document.body.innerHTML =
    '<main id="feed"><div id="a"><a rel="bookmark" href="/a">A</a><p>A source</p></div><div id="b"><a rel="bookmark" href="/b">B</a></div></main><main id="standalone"></main>'
  const first = await read()
  node("b").remove()
  expect(resolveContextScope({ source: node("a") })).toMatchObject({
    type: "FeedItem",
    collection: true,
  })
  expect(await read()).toBe(first)
  node("standalone").append(node("a"))
  expect(resolveContextScope({ source: node("a") }).collection).toBe(false)
})
it("P0-2: removing an explicit feed role can end affinity without moving the node", async () => {
  await read()
  node("b").remove()
  node("feed").removeAttribute("role")
  expect(resolveContextScope({ source: node("a") }).collection).toBe(false)
  expect((await read()).webDescription).toBe("Document description")
})
it("P0-2: moving between feeds and recycling source updates context but not unrelated items", async () => {
  const first = await read(),
    b = await read("b")
  node("standalone").setAttribute("role", "feed")
  node("standalone").append(node("a"))
  expect(resolveContextScope({ source: node("a") })).toMatchObject({
    type: "FeedItem",
    collection: true,
  })
  expect((await read()).identity).toBe(first.identity)
  node("a").querySelector("p")!.textContent = "Recycled post source"
  expect((await read()).identity).not.toBe(first.identity)
  expect(await read("b")).toBe(b)
})
it.each([
  'style="opacity:0"',
  'style="content-visibility:hidden"',
  "inert",
  'style="visibility:collapse"',
])("P0-3: excludes private source under ancestor %s", (attribute) => {
  document.body.innerHTML = `<main ${attribute}><article id="a"><p>PRIVATE_SOURCE</p></article></main>`
  const result = projectSourceRegion(node("a"), {
    maxCharacters: 2000,
    maxNodes: 2048,
    sanitize: true,
  })
  expect(result.document.body.textContent).not.toContain("PRIVATE_SOURCE")
})
it.each([
  'style="opacity:0.5"',
  'style="content-visibility:auto"',
  'style="position:absolute;top:10000px"',
  'style="position:absolute;clip:rect(0,0,0,0)"',
])("P0-3: retains readable or accessible source under %s", (attribute) => {
  document.body.innerHTML = `<main ${attribute}><article id="a"><p>READABLE_SOURCE</p></article></main>`
  expect(
    projectSourceRegion(node("a"), { maxCharacters: 2000, maxNodes: 2048, sanitize: true }).document
      .body.textContent,
  ).toContain("READABLE_SOURCE")
})
it("P0-3: a transparent shadow host cannot leak a nested source", () => {
  const host = document.createElement("div")
  host.style.opacity = "0"
  document.body.append(host)
  const shadow = host.attachShadow({ mode: "open" })
  shadow.innerHTML = "<article><p>PRIVATE_SHADOW</p></article>"
  expect(
    projectSourceRegion(shadow.querySelector("article")!, {
      maxCharacters: 2000,
      maxNodes: 2048,
      sanitize: true,
    }).document.body.textContent,
  ).not.toContain("PRIVATE_SHADOW")
})

it("P0-2: 100 generic feed items survive deterministic reorder and deletion to one", async () => {
  document.body.innerHTML =
    '<main id="feed">' +
    Array.from(
      { length: 100 },
      (_, i) =>
        `<div id="item-${i}" role="listitem"><a rel="bookmark" href="/post/${i}">Post ${i}</a><p>Source ${i}</p></div>`,
    ).join("") +
    "</main>"
  const source = node("item-0")
  const initialScope = resolveContextScope({ source })
  const snapshot = await manager.read({ source }, FULL_CONTEXT)
  for (let i = 0; i < 100; i++) {
    node("feed").append(node(`item-${(i * 37) % 100}`))
    expect(resolveContextScope({ source })).toMatchObject({
      id: initialScope.id,
      type: "FeedItem",
      collection: true,
      confidence: "structural",
    })
  }
  for (let i = 1; i < 100; i++) node(`item-${i}`).remove()
  expect(await manager.read({ source }, FULL_CONTEXT)).toBe(snapshot)
  expect(snapshot.webDescription).toBe("")
  expect(manager.inspect().projections).toBe(1)
})
it("P0-2: replacing a semantic feed container retains only proven current ownership", async () => {
  const first = await read()
  const replacement = document.createElement("main")
  replacement.setAttribute("role", "feed")
  replacement.append(node("a"))
  node("feed").replaceWith(replacement)
  expect(resolveContextScope({ source: node("a") })).toMatchObject({
    type: "FeedItem",
    collection: true,
  })
  expect((await read()).identity).toBe(first.identity)
  replacement.removeAttribute("role")
  expect(resolveContextScope({ source: node("a") }).collection).toBe(false)
})
it("P0-2: normal standalone paragraphs do not imply a collection", async () => {
  node("standalone").append(node("a"))
  node("a").insertAdjacentHTML("beforeend", "<p>Second paragraph</p><p>Third paragraph</p>")
  expect(resolveContextScope({ source: node("a").querySelector("p") })).toMatchObject({
    type: "Article",
    collection: false,
  })
  expect((await read()).webDescription).toBe("Document description")
})
it("P0-1: only explicitly referencing scopes follow a changed external quote", async () => {
  node("a").insertAdjacentHTML(
    "beforeend",
    '<blockquote cite="#quote">Explicit quotation</blockquote>',
  )
  document.body.insertAdjacentHTML(
    "beforeend",
    '<article id="quote"><p>Quote original</p></article>',
  )
  const a = await read(),
    b = await read("b")
  node("quote").querySelector("p")!.textContent = "Quote updated"
  expect((await read()).identity).not.toBe(a.identity)
  expect((await read()).webContent).toContain("Quote updated")
  expect(await read("b")).toBe(b)
})
it("P0-1: local shadow edits and visibility refresh only the acquired shadow scope", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const shadow = host.attachShadow({ mode: "open" })
  shadow.innerHTML = "<article><h2>Shadow title</h2><p>Shadow source</p></article>"
  const source = shadow.querySelector("p")!
  const b = await read("b")
  const first = await manager.read({ source }, FULL_CONTEXT)
  source.textContent = "Shadow updated"
  expect((await manager.read({ source }, FULL_CONTEXT)).identity).not.toBe(first.identity)
  host.style.opacity = "0"
  expect((await manager.read({ source }, FULL_CONTEXT)).webContent).not.toContain("Shadow updated")
  expect(await read("b")).toBe(b)
})
it("P0-1: asynchronous read interleaved with root replacement cannot cache detached content", async () => {
  const old = node("a")
  const pending = read().catch((error) => error)
  old.outerHTML = '<article id="a"><p>Replacement article</p></article>'
  manager.invalidation.flush()
  await pending
  expect((await read()).webContent).toContain("Replacement article")
  expect(manager.inspect().activeExtractions).toBe(0)
})
it("P0-3: foreign-frame sources, controls and editable values are excluded; SVG and offscreen text remain", () => {
  document.body.innerHTML =
    '<article id="a"><p>Readable</p><input type="password" value="PRIVATE_PASSWORD"><textarea>PRIVATE_TEXTAREA</textarea><div contenteditable>PRIVATE_EDITABLE</div><div contenteditable="false">READONLY_SOURCE</div><svg><text>SVG_SOURCE</text><foreignObject><input value="PRIVATE_SVG_INPUT"></foreignObject></svg><iframe></iframe></article>'
  const projection = projectSourceRegion(node("a"), {
    maxCharacters: 2000,
    maxNodes: 2048,
    sanitize: true,
  })
  expect(projection.document.body.textContent).not.toContain("PRIVATE_")
  expect(projection.document.body.textContent).toContain("READONLY_SOURCE")
  expect(projection.document.body.textContent).toContain("SVG_SOURCE")
  const frame = document.querySelector("iframe")!.contentDocument!
  frame.body.innerHTML = "<p>PRIVATE_FRAME</p>"
  expect(
    projectSourceRegion(frame.body, { maxCharacters: 2000, maxNodes: 2048, sanitize: true })
      .document.body.textContent,
  ).toBe("")
})
it.each(["opacity:0", "content-visibility:hidden", "visibility:collapse"])(
  "P0-3: direct %s hides only the private subtree and restoration is visible",
  (style) => {
    node("a").innerHTML = `<p style="${style}">PRIVATE_CHILD</p><p>PUBLIC_SIBLING</p>`
    const project = () =>
      projectSourceRegion(node("a"), { maxCharacters: 2000, maxNodes: 2048, sanitize: true })
    const first = project()
    expect(first.document.body.textContent).toBe("PUBLIC_SIBLING")
    node("a").querySelector("p")!.removeAttribute("style")
    expect(project().document.body.textContent).toContain("PRIVATE_CHILD")
    expect(first.styleReads).toBeLessThanOrEqual(6)
  },
)
it("P0-3: inert removal restores eligible source", async () => {
  node("a").setAttribute("inert", "")
  expect((await read()).webContent).not.toContain("A source")
  node("a").removeAttribute("inert")
  expect((await read()).webContent).toContain("A source")
})

it("P0-1: parser-sensitive class changes cannot be treated as presentation", async () => {
  const first = await read()
  node("a").querySelector("p")!.className = "parser-omit"
  const second = await read()
  expect(second.webContent).not.toContain("A source")
  expect(second.identity).not.toBe(first.identity)
  expect(manager.inspect().projections).toBe(2)
})

it("P0-1: removing a local heading registers the newly used document title", async () => {
  node("standalone").append(node("a"))
  const requirements = { ...NO_CONTEXT, title: true }
  expect((await manager.read({ source: node("a") }, requirements)).webTitle).toBe("A heading")
  node("a").querySelector("h2")!.remove()
  expect((await manager.read({ source: node("a") }, requirements)).webTitle).toBe("Document title")
  document.title = "New document title"
  expect((await manager.read({ source: node("a") }, requirements)).webTitle).toBe(
    "New document title",
  )
})

it("P0-3: an extension-owned shadow host cannot supply source context", () => {
  const host = document.createElement("div")
  host.className = REACT_SHADOW_HOST_CLASS
  document.body.append(host)
  const shadow = host.attachShadow({ mode: "open" })
  shadow.innerHTML = "<article><p>EXTENSION_PRIVATE_UI</p></article>"
  expect(
    projectSourceRegion(shadow, { maxCharacters: 2000, maxNodes: 2048, sanitize: true }).document
      .body.textContent,
  ).toBe("")
  host.className = "website-host"
  expect(
    projectSourceRegion(shadow, { maxCharacters: 2000, maxNodes: 2048, sanitize: true }).document
      .body.textContent,
  ).toContain("EXTENSION_PRIVATE_UI")
})

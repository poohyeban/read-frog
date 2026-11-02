// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { CONTENT_WRAPPER_CLASS } from "@/utils/constants/dom-labels"
import { releaseDocumentIdentity } from "../document-lifetime"
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
    return new DOMParser().parseFromString(html, "text/html").body.textContent ?? ""
  },
}))
let manager: ContextSnapshotManager
beforeEach(() => {
  hooks.convert.mockReset()
  document.body.innerHTML =
    '<main><article id="a"><h2>A title</h2><p>A_SOURCE</p></article><article id="b"><h2>B title</h2><p>B_SOURCE</p></article></main>'
  manager = new ContextSnapshotManager(8)
})
afterEach(() => {
  manager.clear()
  releaseDocumentIdentity()
})
const source = (id: string) => document.querySelector(`#${id} p`)!
const read = (id: string) => manager.read({ source: source(id) }, FULL_CONTEXT)

it("freezes scoped snapshots and rebuilds only the affected scope", async () => {
  const a = await read("a")
  const b = await read("b")
  expect(Object.isFrozen(a)).toBe(true)
  expect(Object.isFrozen(a.requirements)).toBe(true)
  expect(a.webContent).not.toContain("B_SOURCE")
  source("b").textContent = "B_CHANGED"
  expect(await read("a")).toBe(a)
  expect((await read("b")).identity).not.toBe(b.identity)
  expect(a.webContent).toContain("A_SOURCE")
})
it("deletes only detached scopes and leaves a retained snapshot immutable", async () => {
  const a = await read("a")
  const b = await read("b")
  document.querySelector("#b")!.remove()
  manager.invalidation.flush()
  expect(manager.inspect().scopes).toBe(1)
  expect(await read("a")).toBe(a)
  expect(b.webContent).toContain("B_SOURCE")
  expect(manager.isCurrent(b)).toBe(false)
})
it("moves preserve scope identity and virtualized text replacement changes the fingerprint", async () => {
  const a = await read("a")
  document.querySelector("main")!.append(document.querySelector("#a")!)
  expect(await read("a")).toBe(a)
  source("a").textContent = "A_RECYCLED"
  const next = await read("a")
  expect(next.scopeIdentity).toBe(a.scopeIdentity)
  expect(next.fingerprint).not.toBe(a.fingerprint)
})
it("tracks explicit reference dependencies without linking unrelated posts", async () => {
  document
    .querySelector("main")!
    .insertAdjacentHTML(
      "beforeend",
      '<article id="c"><blockquote cite="#a">Quoted</blockquote><p>Reply</p></article>',
    )
  const c = await read("c")
  const b = await read("b")
  expect(c.webContent).toContain("A_SOURCE")
  expect(c.webContent).not.toContain("B_SOURCE")
  source("a").textContent = "NEW_PARENT"
  expect((await read("c")).identity).not.toBe(c.identity)
  expect(await read("b")).toBe(b)
})
it("does no projection for metadata-only or unused context", async () => {
  await manager.read({ source: source("a") }, NO_CONTEXT)
  await manager.read({ source: source("a") }, { ...NO_CONTEXT, title: true })
  expect(manager.inspect().projections).toBe(0)
})
it("ignores inserted translations and excludes private controls and hidden source", async () => {
  const a = await read("a")
  document
    .querySelector("#a")!
    .insertAdjacentHTML(
      "beforeend",
      `<span class="${CONTENT_WRAPPER_CLASS}">INJECTED_TRANSLATION</span>`,
    )
  expect(await read("a")).toBe(a)
  document
    .querySelector("#a")!
    .insertAdjacentHTML(
      "beforeend",
      '<input value="SECRET_INPUT"><textarea>SECRET_TEXT</textarea><script>SECRET_SCRIPT</script><span hidden>SECRET_HIDDEN</span><div contenteditable="true">SECRET_EDITOR</div>',
    )
  const next = await read("a")
  expect(next.webContent).not.toMatch(/SECRET_|INJECTED_TRANSLATION/)
  expect(next.identity).toBe(a.identity)
})
it("bounded index and cache converge after 500 acquire/remove operations", async () => {
  for (let i = 0; i < 500; i++) {
    const article = document.createElement("article")
    article.textContent = `Scoped source ${i}`
    document.body.append(article)
    await manager.read({ source: article }, FULL_CONTEXT)
    if (i % 2 === 0) article.remove()
    manager.invalidation.flush()
    expect(manager.inspect().snapshots).toBeLessThanOrEqual(8)
    expect(manager.inspect().invalidation.observers).toBeLessThanOrEqual(1)
  }
  manager.clear()
  expect(manager.inspect()).toMatchObject({
    scopes: 0,
    snapshots: 0,
    activePreparations: 0,
    workEntries: 0,
    invalidation: { observers: 0, registrations: 0, observedRoots: 0 },
  })
}, 20_000)

it("one cancelled consumer cannot cancel a shared extraction still needed by another", async () => {
  const owner = new AbortController()
  const first = manager
    .read({ source: source("a") }, FULL_CONTEXT, owner.signal)
    .catch((error) => error)
  const second = read("a")
  owner.abort()
  expect(await first).toMatchObject({ name: "TranslationCancelledError" })
  expect((await second).webContent).toContain("A_SOURCE")
  expect(manager.inspect().rebuilds).toBe(1)
})
it("limits a giant scope projection without copying its complete subtree", async () => {
  // Creating 50,000 jsdom nodes is part of this stress fixture, not the
  // bounded projection. Shared CI CPUs can exceed the default 5s wall time.
  const article = document.querySelector("#a")!
  article.innerHTML = Array.from(
    { length: 50_000 },
    (_, i) => `<p>English original unit ${i} in the complete article.</p>`,
  ).join("")
  expect(article.childElementCount).toBe(50_000)
  const value = await manager.read({ source: article.firstChild }, FULL_CONTEXT)
  expect(value.webContent.length).toBeLessThanOrEqual(2000)
  expect(value.provenance.truncated).toBe(true)
  expect(manager.inspect().visitedNodes).toBeLessThanOrEqual(2048)
}, 20_000)

it("releases old route registrations and followed shadow roots", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const shadow = host.attachShadow({ mode: "open" })
  shadow.innerHTML = "<article><p>Shadow source</p></article>"
  await manager.read({ source: shadow.querySelector("p") }, FULL_CONTEXT)
  expect(manager.inspect().invalidation.observedRoots).toBe(2)
  host.remove()
  manager.invalidation.flush()
  expect(manager.inspect().invalidation.observedRoots).toBe(0)
  await read("a")
  window.history.pushState({}, "", "/new-article-route")
  await read("b")
  expect(manager.inspect().scopes).toBe(1)
})
it("never extracts a hidden ancestor or SVG script, including a local fallback", async () => {
  document.body.innerHTML =
    '<main hidden><p id="secret">PRIVATE_ANCESTOR</p></main><article><svg><script>PRIVATE_SVG</script></svg><p id="public">Public source</p></article>'
  const hidden = await manager.read({ source: document.querySelector("#secret") }, FULL_CONTEXT)
  const visible = await manager.read({ source: document.querySelector("#public") }, FULL_CONTEXT)
  expect(hidden.webContent).not.toContain("PRIVATE_")
  expect(visible.webContent).not.toContain("PRIVATE_")
})
it("metadata is an explicit dependency only of scopes which use it", async () => {
  document.body.innerHTML = "<article><p>Single article source</p></article>"
  const paragraph = document.querySelector("p")!
  const first = await manager.read({ source: paragraph }, FULL_CONTEXT)
  document.title = "A genuinely changed source title"
  const next = await manager.read({ source: paragraph }, FULL_CONTEXT)
  expect(next.webTitle).toBe("A genuinely changed source title")
  expect(next.identity).not.toBe(first.identity)
})

it("rebinds explicit dependencies when a recycled reply changes its reference", async () => {
  document
    .querySelector("main")!
    .insertAdjacentHTML(
      "beforeend",
      '<article id="c"><blockquote cite="#a">Reply context</blockquote><p>Reply source</p></article>',
    )
  await read("c")
  document.querySelector("#c blockquote")!.setAttribute("cite", "#b")
  expect((await read("c")).webContent).toContain("B_SOURCE")
  source("b").textContent = "B_UPDATED_AFTER_REBIND"
  expect((await read("c")).webContent).toContain("B_UPDATED_AFTER_REBIND")
  const stable = await read("c")
  source("a").textContent = "NO_LONGER_REFERENCED"
  expect(await read("c")).toBe(stable)
})
it("does not resurrect a coordinator result after a detached source entry was removed", async () => {
  const small = new ContextSnapshotManager(1)
  await small.read({ source: source("a") }, FULL_CONTEXT)
  const node = source("a")
  const article = node.closest("article")!
  article.remove()
  small.invalidation.flush()
  node.textContent = "A_CHANGED_WHILE_EVICTED"
  document.querySelector("main")!.append(article)
  const value = await small.read({ source: node }, FULL_CONTEXT)
  expect(value.webContent).toContain("A_CHANGED_WHILE_EVICTED")
  small.clear()
})

it("retries preparation once before any model request, and bounds continued source churn", async () => {
  hooks.convert.mockImplementationOnce(() => {
    source("a").textContent = "LATEST_SOURCE"
  })
  expect((await read("a")).webContent).toContain("LATEST_SOURCE")
  expect(hooks.convert).toHaveBeenCalledTimes(2)
  source("a").textContent = "Start changing"
  hooks.convert.mockReset().mockImplementation(() => {
    source("a").append(document.createTextNode(" edit"))
  })
  await expect(read("a")).rejects.toMatchObject({ code: "CONTEXT_STALE", reason: "context-stale" })
  expect(hooks.convert).toHaveBeenCalledTimes(2)
  expect(manager.inspect().activePreparations).toBe(0)
})

it("invalidates an acquired scope when an ancestor becomes hidden", async () => {
  await read("a")
  document.querySelector("main")!.hidden = true
  const hidden = await read("a")
  expect(hidden.webContent).not.toContain("A_SOURCE")
  expect(hidden.webTitle).not.toContain("A title")
})
it("does not read translated or hidden text into a scoped title", async () => {
  document
    .querySelector("#a h2")!
    .insertAdjacentHTML(
      "beforeend",
      `<span class="${CONTENT_WRAPPER_CLASS}">TRANSLATED_HEADING</span><span hidden>PRIVATE_HEADING</span>`,
    )
  const value = await read("a")
  expect(value.webTitle).toBe("A title")
})

it("bounds pending extraction across repeated generations of one scope", async () => {
  const initial = await read("a")
  const small = new ContextSnapshotManager(2)
  const releases: Array<(value: typeof initial) => void> = []
  const extract = vi
    .spyOn(small as unknown as { extract: () => Promise<typeof initial> }, "extract")
    .mockImplementation(() => new Promise((resolve) => releases.push(resolve)))
  const owners = Array.from({ length: 5 }, () => new AbortController())
  const results: Array<Promise<unknown>> = []
  try {
    for (const [index, owner] of owners.entries()) {
      source("a").textContent = `Generation ${index}`
      results.push(
        small.read({ source: source("a") }, FULL_CONTEXT, owner.signal).catch((error) => error),
      )
      for (let tick = 0; tick < 8; tick++) await Promise.resolve()
    }
    // Mutation candidates now coalesce while extraction is pending. Explicit
    // invalidation still exercises the overlapping-generation capacity bound.
    expect(extract).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 3; index++) {
      small.invalidateAll()
      results.push(
        small
          .read({ source: source("a") }, FULL_CONTEXT, owners[0]!.signal)
          .catch((error) => error),
      )
      for (let tick = 0; tick < 8; tick++) await Promise.resolve()
    }
    expect(extract).toHaveBeenCalledTimes(2)
    expect(small.inspect().activeExtractions).toBe(2)
  } finally {
    owners.forEach((owner) => owner.abort())
    releases.forEach((resolve) => resolve(initial))
    await Promise.all(results)
    small.clear()
  }
  expect(small.inspect().activePreparations).toBe(0)
  expect(small.inspect().invalidation.observers).toBe(0)
})

it("excludes sources under a hidden shadow host", async () => {
  const host = document.createElement("div")
  host.hidden = true
  document.body.append(host)
  const shadow = host.attachShadow({ mode: "open" })
  shadow.innerHTML = "<article><h2>Private heading</h2><p>PRIVATE_SHADOW_SOURCE</p></article>"
  const value = await manager.read({ source: shadow.querySelector("p") }, FULL_CONTEXT)
  expect(value.webContent).not.toContain("PRIVATE_SHADOW_SOURCE")
  expect(value.webTitle).not.toContain("Private heading")
})

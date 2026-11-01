// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest"
import { findScopeElement, resolveContextScope } from "../scope-resolver"

beforeEach(() => {
  document.body.replaceChildren()
})
it("uses article roots, generic feeds, sections and conservative local fallbacks", () => {
  document.body.innerHTML =
    '<article><p id="article">Article</p></article><div role="feed"><div><p id="feed">Post</p></div></div><main><section aria-label="Chapter"><p id="section">Chapter source</p></section><p id="local">Unclassified source</p></main>'
  for (const [id, type] of [
    ["article", "Article"],
    ["feed", "FeedItem"],
    ["section", "Section"],
    ["local", "Independent"],
  ]) {
    const scope = resolveContextScope({ source: document.getElementById(id!)! })
    expect(scope.type).toBe(type)
    expect(scope.root).not.toBe(document.body)
  }
})
it("does not manufacture a thread from adjacent posts", () => {
  document.body.innerHTML =
    '<article id="a">First</article><article id="b">Reply-looking text</article><article id="c"><blockquote cite="#a">Explicit quotation</blockquote></article>'
  expect(resolveContextScope({ source: document.querySelector("#b") }).dependencies).toEqual([])
  const quoted = resolveContextScope({ source: document.querySelector("#c") })
  expect(quoted.type).toBe("Thread")
  expect(quoted.dependencies).toEqual([document.querySelector("#a")])
})
it("keeps ShadowRoot boundaries and rejects a foreign-frame source", () => {
  const host = document.createElement("div")
  document.body.append(host)
  const shadow = host.attachShadow({ mode: "open" })
  shadow.innerHTML = "<article><p>Shadow article</p></article>"
  expect(resolveContextScope({ source: shadow.querySelector("p") }).root).toBe(
    shadow.querySelector("article"),
  )
  const foreign = document.implementation.createHTMLDocument()
  expect(() => resolveContextScope({ source: foreign.body, document })).toThrow(/another document/)
})
it("resolves only an explicit same-document quotation, never external or arbitrary links", () => {
  document.body.innerHTML =
    '<article id="a">Referenced</article><article id="b"><a href="#a">Near link</a><blockquote cite="https://unrelated.example/#a">External quote</blockquote></article>'
  expect(resolveContextScope({ source: document.querySelector("#b") }).dependencies).toEqual([])
})
it("property: random reorder, insertion and removal cannot cross independent item boundaries", () => {
  let seed = 0x62b9
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const feed = document.createElement("div")
  feed.setAttribute("role", "feed")
  document.body.append(feed)
  const items = Array.from({ length: 100 }, (_, i) => {
    const item = document.createElement("div")
    item.innerHTML = `<span><a rel="bookmark" href="/posts/${i}">${i}</a><p>Unique source ${i}</p></span>`
    feed.append(item)
    return {
      item,
      source: item.querySelector("p")!,
      id: resolveContextScope({ source: item.querySelector("p") }).id,
    }
  })
  for (let iteration = 0; iteration < 1000; iteration++) {
    const selected = items[Math.floor(random() * items.length)]!
    if (random() < 0.5) feed.prepend(selected.item)
    else {
      selected.item.remove()
      feed.append(selected.item)
    }
    const scope = resolveContextScope({ source: selected.source })
    expect(scope.root).toBe(selected.item)
    expect(scope.id).toBe(selected.id)
    expect(scope.dependencies).toHaveLength(0)
  }
})

it("bounds probes even when every child is an opaque semantic item", () => {
  const root = document.createElement("div")
  root.innerHTML = "<article>Unrelated source</article>".repeat(1000)
  const matches = vi.spyOn(Element.prototype, "matches")
  try {
    expect(findScopeElement(root, "h1")).toBeUndefined()
    expect(matches.mock.calls.length).toBeLessThanOrEqual(193)
  } finally {
    matches.mockRestore()
  }
})

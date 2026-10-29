// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildSectionSearch,
  getSectionIdFromSearch,
  scrollToSectionWhenReady,
} from "../section-scroll"

const mockedWaitForElement = vi.hoisted(() => vi.fn<(...args: any[]) => any>())

vi.mock("@/utils/dom/wait-for-element", () => ({
  waitForElement: mockedWaitForElement,
}))

describe("section-scroll", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    mockedWaitForElement.mockReset()
  })

  it("builds and parses section query params", () => {
    const search = buildSectionSearch("request-rate")
    expect(search).toBe("?section=request-rate")
    expect(getSectionIdFromSearch(search)).toBe("request-rate")
  })

  it("ignores missing or blank section params", () => {
    expect(getSectionIdFromSearch("")).toBeNull()
    expect(getSectionIdFromSearch("?foo=bar")).toBeNull()
    expect(getSectionIdFromSearch("?section=")).toBeNull()
    expect(getSectionIdFromSearch("?section=%20%20")).toBeNull()
  })

  it("scrolls immediately when section already exists", async () => {
    const section = document.createElement("section")
    section.id = "request-rate"
    document.body.appendChild(section)

    const scrollIntoViewSpy = vi.fn<(...args: any[]) => any>()
    Object.defineProperty(section, "scrollIntoView", {
      value: scrollIntoViewSpy,
      configurable: true,
    })

    const didScroll = await scrollToSectionWhenReady("request-rate")

    expect(didScroll).toBe(true)
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" })
    expect(mockedWaitForElement).not.toHaveBeenCalled()
  })

  it("waits for section mount when section is not yet in the DOM", async () => {
    const delayedSection = document.createElement("section")
    delayedSection.id = "request-rate"
    const scrollIntoViewSpy = vi.fn<(...args: any[]) => any>()
    Object.defineProperty(delayedSection, "scrollIntoView", {
      value: scrollIntoViewSpy,
      configurable: true,
    })
    mockedWaitForElement.mockResolvedValueOnce(delayedSection)

    const didScroll = await scrollToSectionWhenReady("request-rate")

    expect(didScroll).toBe(true)
    expect(mockedWaitForElement).toHaveBeenCalledWith(expect.stringContaining("request-rate"))
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" })
  })

  it("returns false when section never appears", async () => {
    mockedWaitForElement.mockResolvedValueOnce(null)

    const didScroll = await scrollToSectionWhenReady("missing-section")

    expect(didScroll).toBe(false)
  })

  describe("sections inside tabs", () => {
    // Mirrors base-ui: a kept-mounted inactive panel is `hidden` + `inert` and labelled by its tab,
    // and the tab points back at it with `aria-controls`.
    function renderTabs() {
      document.body.innerHTML = `
        <div role="tablist">
          <button role="tab" id="tab-config" aria-controls="panel-config" aria-selected="true">Config</button>
          <button role="tab" id="tab-notebase" aria-controls="panel-notebase" aria-selected="false">Notebase</button>
        </div>
        <div role="tabpanel" id="panel-config" aria-labelledby="tab-config">
          <h3 id="layout-heading">Layout</h3>
        </div>
        <div role="tabpanel" id="panel-notebase" aria-labelledby="tab-notebase" hidden inert>
          <div id="notebase-mappings">Mappings</div>
        </div>
      `
      const events: string[] = []
      for (const tab of document.querySelectorAll<HTMLElement>('[role="tab"]')) {
        tab.addEventListener("click", () => {
          events.push(`click:${tab.id}`)
          for (const other of document.querySelectorAll('[role="tab"]')) {
            const selected = other === tab
            other.setAttribute("aria-selected", String(selected))
            const panel = document.querySelector(`[aria-labelledby="${other.id}"]`)!
            panel.toggleAttribute("hidden", !selected)
            panel.toggleAttribute("inert", !selected)
          }
        })
      }
      return events
    }

    function spyScroll(element: Element, events: string[]) {
      const spy = vi.fn<(...args: any[]) => any>(() => {
        events.push(`scroll:${element.id}`)
      })
      Object.defineProperty(element, "scrollIntoView", { value: spy, configurable: true })
      return spy
    }

    it("clicks nothing when the section is already visible", async () => {
      const events = renderTabs()
      spyScroll(document.getElementById("layout-heading")!, events)
      spyScroll(document.getElementById("tab-config")!, events)

      await scrollToSectionWhenReady("layout-heading")
      await scrollToSectionWhenReady("tab-config")

      expect(events).toEqual(["scroll:layout-heading", "scroll:tab-config"])
    })
  })
})

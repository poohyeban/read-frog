// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("@/components/ui/json-code-editor", () => ({ preloadJSONCodeEditor: () => {} }))
import { AdvancedOptionsSection } from "./advanced-options-section"
afterEach(cleanup)
describe("advanced options lifecycle", () => {
  it("defers editor mounting until first open and preserves a hidden invalid draft", () => {
    render(
      <AdvancedOptionsSection>
        <input aria-label="JSON draft" defaultValue="" />
      </AdvancedOptionsSection>,
    )
    expect(screen.queryByLabelText("JSON draft")).toBeNull()
    const trigger = screen.getByText("options.apiProviders.form.advancedOptions")
    fireEvent.click(trigger)
    fireEvent.change(screen.getByLabelText("JSON draft"), { target: { value: '{"unfinished":' } })
    fireEvent.click(trigger)
    expect(screen.getByLabelText("JSON draft")).toHaveValue('{"unfinished":')
    fireEvent.click(trigger)
    expect(screen.getByLabelText("JSON draft")).toHaveValue('{"unfinished":')
  })
})

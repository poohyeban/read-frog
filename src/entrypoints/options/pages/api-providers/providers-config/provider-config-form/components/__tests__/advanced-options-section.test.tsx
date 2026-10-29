// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, expect, it } from "vitest"
import { AdvancedOptionsSection } from "../advanced-options-section"

afterEach(cleanup)
it("defers initial editor mounting and preserves an edited draft across collapse and reopen", () => {
  function Draft() {
    const [text, setText] = useState("initial")
    return (
      <input aria-label="draft" value={text} onChange={(event) => setText(event.target.value)} />
    )
  }
  render(
    <AdvancedOptionsSection>
      <Draft />
    </AdvancedOptionsSection>,
  )
  expect(screen.queryByLabelText("draft")).toBeNull()
  const trigger = screen.getByRole("button")
  fireEvent.click(trigger)
  fireEvent.change(screen.getByLabelText("draft"), { target: { value: "unfinished draft" } })
  fireEvent.click(trigger)
  fireEvent.click(trigger)
  expect(screen.getByLabelText("draft")).toHaveValue("unfinished draft")
})

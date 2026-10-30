// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Switch } from "../switch"
afterEach(cleanup)
describe("shared switch", () => {
  it("keeps native checked semantics and reports a single toggle", () => {
    const changed = vi.fn<() => void>()
    render(<Switch aria-label="Feature" defaultChecked onCheckedChange={changed} />)
    const control = screen.getByRole("switch", { name: "Feature" })
    expect(control).toHaveAttribute("aria-checked", "true")
    fireEvent.click(control)
    expect(control).toHaveAttribute("aria-checked", "false")
    expect(changed).toHaveBeenCalledOnce()
  })
  it.each(["disabled", "readOnly"] as const)("does not mutate a %s control", (lock) => {
    const changed = vi.fn<() => void>()
    render(
      <Switch
        aria-label="Feature"
        defaultChecked
        {...{ [lock]: true }}
        onCheckedChange={changed}
      />,
    )
    fireEvent.click(screen.getByRole("switch"))
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true")
    expect(changed).not.toHaveBeenCalled()
  })
  it("honors controlled values and cancellation", () => {
    render(
      <Switch
        aria-label="Feature"
        checked={false}
        onCheckedChange={(_checked, details) => details.cancel()}
      />,
    )
    fireEvent.click(screen.getByRole("switch"))
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false")
  })
})

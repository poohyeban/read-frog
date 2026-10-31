// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PerformanceNumberInput } from "./fields"
afterEach(cleanup)
describe("advanced setting drafts", () => {
  it("keeps typing local and commits on blur", async () => {
    const save = vi.fn<(value: number) => Promise<void>>(async () => {})
    render(<PerformanceNumberInput label="Concurrency" value={2} save={save} />)
    const input = screen.getByLabelText("Concurrency")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "8" } })
    expect(save).not.toHaveBeenCalled()
    fireEvent.blur(input)
    await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(8))
  })
  it("does not save an unchanged value, empty draft or a mere rerender", async () => {
    const save = vi.fn<(value: number) => Promise<void>>(async () => {})
    const view = render(<PerformanceNumberInput label="Concurrency" value={2} save={save} />)
    view.rerender(<PerformanceNumberInput label="Concurrency" value={2} save={save} />)
    fireEvent.blur(screen.getByLabelText("Concurrency"))
    fireEvent.change(screen.getByLabelText("Concurrency"), { target: { value: "" } })
    fireEvent.blur(screen.getByLabelText("Concurrency"))
    expect(await screen.findByRole("alert")).toBeVisible()
    expect(save).not.toHaveBeenCalled()
  })
  it("commits Enter once and reports rejected input without rewriting storage", async () => {
    const save = vi.fn<(value: number) => Promise<void>>(async () => {
      throw new Error("Must be positive")
    })
    render(<PerformanceNumberInput label="Concurrency" value={2} save={save} />)
    const input = screen.getByLabelText("Concurrency")
    input.focus()
    fireEvent.change(input, { target: { value: "-1" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(await screen.findByRole("alert")).toHaveTextContent("Must be positive")
    expect(save).toHaveBeenCalledExactlyOnceWith(-1)
  })
  it("preserves a focused draft through external updates and adopts idle snapshots", () => {
    const save = vi.fn<(value: number) => Promise<void>>(async () => {})
    const view = render(<PerformanceNumberInput label="Concurrency" value={2} save={save} />)
    const input = screen.getByLabelText("Concurrency")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "7" } })
    view.rerender(<PerformanceNumberInput label="Concurrency" value={4} save={save} />)
    expect(input).toHaveValue(7)
    fireEvent.keyDown(input, { key: "Escape" })
    expect(input).toHaveValue(4)
    expect(save).not.toHaveBeenCalled()
  })
})

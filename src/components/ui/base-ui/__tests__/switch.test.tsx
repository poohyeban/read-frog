// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { Switch } from "../switch"
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent)
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m41: number
      constructor(transform: string) {
        this.m41 = Number(/translateX\(([-\d.]+)px\)/.exec(transform)?.[1] ?? 0)
      }
    },
  )
  HTMLElement.prototype.setPointerCapture = vi.fn<(...args: any[]) => any>()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
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

function Controlled({ changed }: { changed: (value: boolean) => void }) {
  const [checked, setChecked] = useState(false)
  return (
    <Switch
      aria-label="Drag"
      checked={checked}
      onCheckedChange={(value) => {
        changed(value)
        setChecked(value)
      }}
    />
  )
}
function drag(control: HTMLElement, points: number[], cancel = false) {
  fireEvent.pointerDown(control, { clientX: points[0], button: 0, pointerId: 1 })
  for (const clientX of points.slice(1)) fireEvent.pointerMove(control, { clientX, pointerId: 1 })
  if (cancel) fireEvent.pointerCancel(control, { pointerId: 1 })
  else {
    fireEvent.pointerUp(control, { pointerId: 1 })
    fireEvent.click(control, { detail: 1 })
  }
}
describe("pointer drag boundary", () => {
  it.each([false, true])("applies a single large move with controlled=%s", (controlled) => {
    const changed = vi.fn<(...args: any[]) => any>()
    render(controlled ? <Controlled changed={changed} /> : <Switch onCheckedChange={changed} />)
    const control = screen.getByRole("switch")
    drag(control, [0, 30])
    expect(control).toHaveAttribute("aria-checked", "true")
    expect(changed).toHaveBeenCalledTimes(1)
    drag(control, [30, 0])
    expect(control).toHaveAttribute("aria-checked", "false")
    expect(changed).toHaveBeenCalledTimes(2)
  })
  it("tracks slow moves, reversal, cancellation, then click independently", () => {
    const changed = vi.fn<(...args: any[]) => any>()
    render(<Switch onCheckedChange={changed} />)
    const control = screen.getByRole("switch")
    drag(control, [0, 1, 3, 5, 10, 20, 0])
    expect(changed).not.toHaveBeenCalled()
    drag(control, [0, 30], true)
    expect(changed).not.toHaveBeenCalled()
    fireEvent.click(control, { detail: 0 })
    expect(control).toHaveAttribute("aria-checked", "true")
    expect(changed).toHaveBeenCalledOnce()
  })
  it.each(["disabled", "readOnly"] as const)("ignores dragging when %s", (lock) => {
    const changed = vi.fn<(...args: any[]) => any>()
    render(<Switch {...{ [lock]: true }} onCheckedChange={changed} />)
    drag(screen.getByRole("switch"), [0, 30])
    expect(changed).not.toHaveBeenCalled()
  })
})

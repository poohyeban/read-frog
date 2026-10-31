// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PerformanceSettings } from "./index"
const mocks = vi.hoisted(() => ({
  send: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  state: { version: 1 as const, revision: 0 },
  providers: [{ id: "a", name: "Mock account", enabled: true }],
}))
vi.mock("jotai", () => ({ useAtomValue: () => mocks.providers }))
vi.mock("@/utils/atoms/config", () => ({ configFieldsAtomMap: { providersConfig: "providers" } }))
vi.mock("@/utils/config/performance", () => ({
  initializePerformance: async () => {},
  getPerformanceOverrides: () => mocks.state,
  watchPerformance: () => () => {},
}))
vi.mock("@/utils/message", () => ({ sendMessage: mocks.send }))
beforeEach(() => {
  mocks.send.mockReset()
  mocks.send.mockResolvedValue({ overrides: mocks.state, identities: { a: "opaque-resource" } })
})
afterEach(cleanup)
describe("advanced configuration UI", () => {
  it("starts collapsed and opening, closing and reading never persist default overrides", async () => {
    render(<PerformanceSettings feature="subtitles" providerId="a" />)
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("getPerformanceConfiguration"))
    expect(screen.queryByText("options.performance.description")).toBeNull()
    const trigger = screen.getByRole("button", { name: "options.performance.advanced" })
    fireEvent.click(trigger)
    expect(screen.getByText("options.performance.description")).toBeVisible()
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(
      mocks.send.mock.calls.filter(([type]) => type === "patchPerformanceConfiguration"),
    ).toEqual([])
  })
  it("writes only the edited field and sends a separate explicit reset action", async () => {
    render(<PerformanceSettings providerId="a" />)
    await waitFor(() => expect(mocks.send).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: "options.performance.advanced" }))
    const concurrency = screen.getAllByLabelText("options.performance.fields.maxInFlight")[0]!
    fireEvent.focus(concurrency)
    fireEvent.change(concurrency, { target: { value: "4" } })
    expect(
      mocks.send.mock.calls.filter(([type]) => type === "patchPerformanceConfiguration"),
    ).toEqual([])
    fireEvent.blur(concurrency)
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith("patchPerformanceConfiguration", {
        kind: "set",
        target: { section: "provider", id: "a" },
        field: "maxInFlight",
        value: 4,
      }),
    )
    fireEvent.click(screen.getAllByText("options.performance.reset")[0]!)
    expect(mocks.send).toHaveBeenCalledWith("patchPerformanceConfiguration", {
      kind: "reset",
      target: { section: "provider", id: "a" },
    })
  })
})

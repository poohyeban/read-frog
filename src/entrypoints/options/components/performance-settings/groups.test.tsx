// @vitest-environment jsdom
import type { ProvidersConfig } from "@/types/config/provider"
import type { PerformanceOverrides } from "@/utils/request/performance-config"
import type { PerformancePatch } from "@/utils/request/performance-patch"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createPerformanceWriter } from "@/utils/config/performance-writer"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { PerformanceGroups } from "./groups"

const mock = vi.hoisted(() => ({ send: vi.fn<(...args: any[]) => Promise<any>>() }))
vi.mock("@/utils/message", () => ({ sendMessage: mock.send }))
const groupId = "11111111-1111-4111-8111-111111111111"
const base = DEFAULT_CONFIG.providersConfig[0]!
const providers: ProvidersConfig = [
  { ...base, id: "a", name: "A", enabled: true },
  { ...base, id: "b", name: "B", enabled: false },
  { ...base, id: "c", name: "C", enabled: true },
]
const configuredIdentities = new Map([
  ["a", "ra"],
  ["b", "rb"],
  ["c", "rc"],
])
let stored: PerformanceOverrides
let writer: ReturnType<typeof createPerformanceWriter>
const props = () => ({
  providers,
  identities: Object.fromEntries(configuredIdentities),
  groups: structuredClone(stored.groups),
})
beforeEach(() => {
  stored = {
    version: 1,
    revision: 1,
    groups: { [groupId]: { name: "AB", members: ["ra", "rb"], policy: { rate: 3 } } },
  }
  writer = createPerformanceWriter({
    read: async () => structuredClone(stored),
    write: async (value) => {
      stored = value
    },
    context: async () => ({
      identities: new Map([
        ["a", "ra"],
        ["c", "rc"],
      ]),
      configuredIdentities,
      providerIds: new Set(configuredIdentities.keys()),
      isCurrent: () => true,
    }),
  })
  mock.send.mockReset()
  mock.send.mockImplementation(async (_type, patch: PerformancePatch) => writer.patch(patch))
})
afterEach(cleanup)
function edit() {
  fireEvent.click(screen.getByText("AB"))
  fireEvent.click(screen.getByRole("button", { name: "options.performance.editGroup" }))
}
async function save() {
  fireEvent.click(screen.getByRole("button", { name: "options.performance.save" }))
  await waitFor(() => expect(screen.queryByLabelText("options.performance.groupName")).toBeNull())
}

it("renames AB with disabled B, adds C, and restores B's checked membership after enable", async () => {
  const view = render(<PerformanceGroups {...props()} />)
  edit()
  expect(screen.getByRole("checkbox", { name: "B" })).toBeChecked()
  fireEvent.change(screen.getByLabelText("options.performance.groupName"), {
    target: { value: "ABC" },
  })
  fireEvent.click(screen.getByRole("checkbox", { name: "C" }))
  await save()
  expect(stored.groups?.[groupId]).toEqual({
    name: "ABC",
    members: ["ra", "rb", "rc"],
    policy: { rate: 3 },
  })
  expect(mock.send).toHaveBeenLastCalledWith("patchPerformanceConfiguration", {
    kind: "edit-group",
    id: groupId,
    name: "ABC",
    addMembers: ["rc"],
    removeMembers: [],
  })
  view.rerender(
    <PerformanceGroups {...props()} providers={providers.map((p) => ({ ...p, enabled: true }))} />,
  )
  fireEvent.click(screen.getByRole("button", { name: "options.performance.editGroup" }))
  expect(screen.getByRole("checkbox", { name: "B" })).toBeChecked()
})

it("renames without sending membership changes even while an identity is not visible", async () => {
  render(<PerformanceGroups {...props()} identities={{ a: "ra", c: "rc" }} />)
  edit()
  fireEvent.change(screen.getByLabelText("options.performance.groupName"), {
    target: { value: "Renamed" },
  })
  await save()
  expect(stored.groups?.[groupId]?.members).toEqual(["ra", "rb"])
  expect(mock.send).toHaveBeenLastCalledWith("patchPerformanceConfiguration", {
    kind: "edit-group",
    id: groupId,
    name: "Renamed",
    addMembers: [],
    removeMembers: [],
  })
})

it("explicitly removes disabled B and can remove the last member without deleting group policy", async () => {
  const view = render(<PerformanceGroups {...props()} />)
  edit()
  fireEvent.click(screen.getByRole("checkbox", { name: "B" }))
  await save()
  expect(stored.groups?.[groupId]?.members).toEqual(["ra"])
  view.rerender(<PerformanceGroups {...props()} />)
  fireEvent.click(screen.getByRole("button", { name: "options.performance.editGroup" }))
  fireEvent.click(screen.getByRole("checkbox", { name: "A" }))
  await save()
  expect(stored.groups?.[groupId]).toEqual({ name: "AB", members: [], policy: { rate: 3 } })
})

it("saves only local intent when another editor renames the group and removes B", async () => {
  const view = render(<PerformanceGroups {...props()} />)
  edit()
  fireEvent.click(screen.getByRole("checkbox", { name: "C" }))
  await writer.patch({ kind: "edit-group", id: groupId, name: "Other tab", removeMembers: ["rb"] })
  view.rerender(<PerformanceGroups {...props()} />)
  await save()
  expect(stored.groups?.[groupId]).toEqual({
    name: "Other tab",
    members: ["ra", "rc"],
    policy: { rate: 3 },
  })
  expect(mock.send).toHaveBeenLastCalledWith("patchPerformanceConfiguration", {
    kind: "edit-group",
    id: groupId,
    addMembers: ["rc"],
    removeMembers: [],
  })
})

it("shows one checkbox for aliases of a physical identity and does not persist an untouched draft", async () => {
  const aliasProviders = [...providers, { ...base, id: "b-alias", name: "B alias", enabled: true }]
  render(
    <PerformanceGroups
      {...props()}
      providers={aliasProviders}
      identities={{ ...Object.fromEntries(configuredIdentities), "b-alias": "rb" }}
    />,
  )
  edit()
  expect(screen.getAllByRole("checkbox")).toHaveLength(3)
  expect(screen.getByRole("checkbox", { name: "B / B alias" })).toBeChecked()
  await save()
  expect(stored.revision).toBe(1)
})

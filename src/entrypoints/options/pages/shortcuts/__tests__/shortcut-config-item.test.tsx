// @vitest-environment jsdom
import type { Config } from "@/types/config/config"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { configAtom } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { getShortcutBindings } from "../shortcut-bindings"
import { ShortcutConfigItem } from "../shortcut-config-item"

const toastAdd = vi.hoisted(() => vi.fn<(toast: unknown) => void>())

// Shows the substitutions, so a message can be checked for the shortcut it names.
vi.mock("@/utils/i18n", () => ({
  i18n: {
    t: (key: string, substitutions?: string[]) =>
      substitutions ? `${key}:${substitutions.join("|")}` : key,
  },
}))

vi.mock("@/components/ui/base-ui/toast", () => ({ toastManager: { add: toastAdd } }))

afterEach(() => {
  toastAdd.mockClear()
  fakeBrowser.reset()
})

async function renderItem(
  config: Config,
  shortcut: string,
  onChange = vi.fn<(shortcut: string) => void>(),
) {
  // The config atom reloads from storage once mounted.
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: config })
  const store = createStore()
  store.set(configAtom, config)
  render(
    <Provider store={store}>
      <ShortcutConfigItem
        id="selection-speak-shortcut"
        title="Speak"
        description="Reads aloud"
        shortcut={shortcut}
        onChange={onChange}
      />
    </Provider>,
  )
  return onChange
}

function record(keys: { key: string; altKey?: boolean; shiftKey?: boolean; code?: string }) {
  const input = screen.getByPlaceholderText("shortcutKeySelector.placeholder")
  fireEvent.focus(input)
  fireEvent.keyDown(document, keys)
}

describe("shortcut bindings", () => {
  it("lists the hover translation shortcut only while hover translation uses it", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.pageTranslation.node.shortcut = "Alt+Shift+K"
    const paragraphBinding = (bindings: ReturnType<typeof getShortcutBindings>) =>
      bindings.find((binding) => binding.id === "node-translation-shortcut")

    expect(paragraphBinding(getShortcutBindings(config))).toBeUndefined()

    config.pageTranslation.node.hotkey = "custom"
    expect(paragraphBinding(getShortcutBindings(config))).toEqual({
      id: "node-translation-shortcut",
      title: "options.shortcuts.nodeTranslation.title",
      shortcut: "Alt+Shift+K",
    })
  })
})

describe("ShortcutConfigItem", () => {
  it("turns down a key another shortcut has, naming that shortcut", async () => {
    const onChange = await renderItem(structuredClone(DEFAULT_CONFIG), "Alt+Shift+R")

    record({ key: "t", altKey: true, code: "KeyT" })

    await waitFor(() => {
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: expect.stringMatching(
            /^options\.shortcuts\.taken:.+\|options\.shortcuts\.selectionTranslation\.title$/,
          ),
        }),
      )
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it("saves a key no other shortcut has", async () => {
    const onChange = await renderItem(structuredClone(DEFAULT_CONFIG), "Alt+Shift+R")

    record({ key: "k", altKey: true, shiftKey: true, code: "KeyK" })

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith("Alt+Shift+K")
    })
    expect(toastAdd).not.toHaveBeenCalled()
  })
})

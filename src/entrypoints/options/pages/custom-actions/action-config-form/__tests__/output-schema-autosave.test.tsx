// @vitest-environment jsdom
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { StrictMode } from "react"
import { createMemoryRouter, Link, RouterProvider } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { AutosaveNavigation } from "@/components/form/autosave-navigation"
import { ToastProvider } from "@/components/ui/base-ui/toast"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { configSchema } from "@/types/config/config"
import { configAtom } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { CustomActionConfigForm } from ".."
import { selectedCustomActionIdAtom } from "../../atoms"

// Keep remote discovery/auth out of this test. The schema editor, parent form,
// validation, autosave controller, entity writer and navigation are all real.
vi.mock("../provider-field", () => ({ ProviderField: () => null }))

// The layout's CodeMirror editor and shadow-DOM preview are verified in a browser; the rename
// and delete paths below only touch the form's `layout` value.

function createAction(): SelectionToolbarCustomAction {
  return {
    id: "mapped-action",
    name: "Vocabulary",
    icon: "tabler:book",
    providerId: "openai-default",
    systemPrompt: "Explain the selected text.",
    prompt: "{{selection}}",
    outputSchema: ["meaning", "example"].map((id) => ({
      id,
      name: id,
      type: "string",
      description: id,
    })),
  }
}

async function setup(action: SelectionToolbarCustomAction) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.selectionToolbar.customActions = [action]
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: config })
  const store = createStore()
  store.set(configAtom, config)
  await store.set(selectedCustomActionIdAtom, action.id)
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <AutosaveNavigation />
          <CustomActionConfigForm />
          <Link to="/done">Leave editor</Link>
        </>
      ),
    },
    { path: "/done", element: <p>Left editor</p> },
  ])
  render(
    <StrictMode>
      <Provider store={store}>
        <ToastProvider>
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </ToastProvider>
      </Provider>
    </StrictMode>,
  )
  return { router, store }
}

async function deleteMeaning() {
  const row = screen.getByText("meaning", { selector: "span.font-medium" }).parentElement!
  const deleteButton = within(row).getAllByRole("button")[1]!
  fireEvent.click(deleteButton)
  const dialog = await screen.findByRole("alertdialog")
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "options.selectionToolbar.customActions.form.deleteFieldDialog.confirm",
    }),
  )
}

async function getPersistedAction(): Promise<SelectionToolbarCustomAction> {
  const stored = await fakeBrowser.storage.local.get(CONFIG_STORAGE_KEY)
  return configSchema.parse(stored[CONFIG_STORAGE_KEY]).selectionToolbar.customActions[0]!
}

describe("output schema autosave", () => {
  afterEach(() => vi.restoreAllMocks())

  it("deletes a field normally when no Notebase is connected", async () => {
    const action = createAction()
    await setup(action)

    await deleteMeaning()

    await waitFor(async () =>
      expect((await getPersistedAction()).outputSchema).toEqual([action.outputSchema[1]!]),
    )
  })
})

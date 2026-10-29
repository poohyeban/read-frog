// @vitest-environment jsdom
import type { ProviderConfig } from "@/types/config/provider"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { SelectionToolbarFooterContent } from "../selection-toolbar-footer-content"

vi.mock("@/components/llm-providers/provider-selector", () => ({
  default: ({
    className,
    onChange,
    providers,
    value,
  }: {
    className?: string
    onChange: (id: string) => void
    providers: ProviderConfig[]
    value: string
  }) => {
    const nextProvider = providers.find((provider) => provider.id !== value)

    return (
      <button
        type="button"
        data-testid="provider-selector"
        className={className}
        onClick={() => {
          if (nextProvider) {
            onChange(nextProvider.id)
          }
        }}
      >
        {value}
      </button>
    )
  },
}))

describe("selectionToolbarFooterContent", () => {
  const providers: ProviderConfig[] = [
    {
      id: "google-translate-default",
      name: "Google Translate",
      enabled: true,
      provider: "google-translate",
    },
  ]

  it("shows placeholders when title and context are empty", async () => {
    render(
      <TooltipProvider>
        <SelectionToolbarFooterContent
          paragraphsText={null}
          providers={providers}
          titleText=""
          value="google-translate-default"
          onProviderChange={vi.fn<(...args: any[]) => any>()}
          onRegenerate={vi.fn<(...args: any[]) => any>()}
        />
      </TooltipProvider>,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "action.viewContextDetails" }))
      await Promise.resolve()
    })

    expect(screen.getAllByText("—")).toHaveLength(2)
  })
})

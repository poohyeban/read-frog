// @vitest-environment jsdom
import type { ReactNode } from "react"
import type { ProviderSelectorOption } from "@/utils/providers/provider-display"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ThemeContext } from "@/components/providers/theme-provider"
import ProviderSelector from "../provider-selector"

const provider: ProviderSelectorOption = {
  id: "local-service",
  provider: "openai-compatible",
  name: "Local service",
  enabled: true,
  baseURL: "http://127.0.0.1:8080/v1",
  model: { model: "use-custom-model", isCustomModel: true, customModel: "local-model" },
}

function ThemeWrapper({ children }: { children: ReactNode }) {
  return (
    <ThemeContext
      value={{
        theme: "light",
        themeMode: "light",
        setThemeMode: vi.fn<(mode: "light" | "dark" | "system") => void>(),
      }}
    >
      {children}
    </ThemeContext>
  )
}

afterEach(cleanup)

describe("ProviderSelector empty service configuration", () => {
  it("renders an unconfigured service without selecting an available provider", () => {
    const onChange = vi.fn<(id: string) => void>()
    render(
      <ProviderSelector
        providers={[provider]}
        value=""
        onChange={onChange}
        placeholder="Configure service"
      />,
      { wrapper: ThemeWrapper },
    )
    expect(screen.getByRole("combobox")).toHaveTextContent("Configure service")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("clears the displayed provider when its reference is removed", () => {
    const onChange = vi.fn<(id: string) => void>()
    const { rerender } = render(
      <ProviderSelector
        providers={[provider]}
        value={provider.id}
        onChange={onChange}
        placeholder="Configure service"
      />,
      { wrapper: ThemeWrapper },
    )
    expect(screen.getByRole("combobox")).toHaveTextContent("Local service")
    rerender(
      <ProviderSelector
        providers={[provider]}
        value=""
        onChange={onChange}
        placeholder="Configure service"
      />,
    )
    expect(screen.getByRole("combobox")).toHaveTextContent("Configure service")
    expect(screen.getByRole("combobox")).not.toHaveTextContent("Local service")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("allows settings to render after the last provider is deleted", () => {
    render(
      <ProviderSelector
        providers={[]}
        value="removed-service"
        onChange={vi.fn<(id: string) => void>()}
        placeholder="Configure service"
      />,
      { wrapper: ThemeWrapper },
    )
    expect(screen.getByRole("combobox")).toHaveTextContent("Configure service")
    expect(screen.getByRole("combobox")).toBeDisabled()
  })
})

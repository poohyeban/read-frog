import type { ComponentProps } from "react"
import type { Theme } from "@/types/config/theme"
import type { ProviderSelectorOption } from "@/utils/providers/provider-display"
import ProviderIcon from "@/components/provider-icon"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/base-ui/select"
import { getProviderLogo, getProviderName } from "@/utils/providers/provider-display"
import { useTheme } from "../providers/theme-provider"

type ProviderSelectorTriggerSize = ComponentProps<typeof SelectTrigger>["size"]

interface ProviderSelectorProps {
  providers: ProviderSelectorOption[]
  value: string
  onChange: (id: string) => void
  placeholder?: string
  className?: string
  /** Applied to the selected provider's name in the trigger, not to the list items. */
  triggerNameClassName?: string
  triggerSize?: ProviderSelectorTriggerSize
  selectContentProps?: Pick<
    ComponentProps<typeof SelectContent>,
    "container" | "positionerClassName" | "align"
  >
}

export default function ProviderSelector({
  providers,
  value,
  onChange,
  placeholder,
  className,
  triggerNameClassName,
  triggerSize = "default",
  selectContentProps,
}: ProviderSelectorProps) {
  const { theme } = useTheme()
  const currentProvider = providers.find((p) => p.id === value)

  return (
    <UngroupedSelect
      providers={providers}
      currentProvider={currentProvider}
      onChange={onChange}
      placeholder={placeholder}
      className={className}
      triggerNameClassName={triggerNameClassName}
      triggerSize={triggerSize}
      selectContentProps={selectContentProps}
      theme={theme}
    />
  )
}

function UngroupedSelect({
  providers,
  currentProvider,
  onChange,
  placeholder,
  className,
  triggerNameClassName,
  triggerSize,
  theme,
  selectContentProps,
}: {
  providers: ProviderSelectorOption[]
  currentProvider: ProviderSelectorOption | undefined
  onChange: (id: string) => void
  placeholder?: string
  className?: string
  triggerNameClassName?: string
  triggerSize: ProviderSelectorTriggerSize
  selectContentProps?: Pick<
    ComponentProps<typeof SelectContent>,
    "container" | "positionerClassName" | "align"
  >
  theme: Theme
}) {
  return (
    <Select<ProviderSelectorOption>
      value={currentProvider}
      onValueChange={(provider) => {
        if (!provider) return
        onChange(provider.id)
      }}
      itemToStringValue={(p) => p.id}
      disabled={providers.length === 0}
    >
      <SelectTrigger className={className} size={triggerSize}>
        <SelectValue placeholder={placeholder}>
          {(provider: ProviderSelectorOption) => (
            <ProviderIcon
              logo={getProviderLogo(provider, theme)}
              name={getProviderName(provider)}
              size="sm"
              textClassName={triggerNameClassName}
            />
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent {...selectContentProps}>
        <SelectGroup>
          {providers.map((provider) => (
            <SelectItem key={provider.id} value={provider}>
              <ProviderOptionContent provider={provider} theme={theme} />
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function ProviderOptionContent({
  provider,
  theme,
}: {
  provider: ProviderSelectorOption
  theme: Theme
}) {
  return (
    <ProviderIcon
      logo={getProviderLogo(provider, theme)}
      name={getProviderName(provider)}
      size="sm"
    />
  )
}

import type { ProvidersConfig } from "@/types/config/provider"
import type { ProviderSelectorOption } from "@/utils/providers/provider-display"
import type { ProviderCapability } from "@/utils/providers/provider-registry"
import { IconChevronRight } from "@tabler/icons-react"
import { dequal } from "dequal"
import { useAtomValue } from "jotai"
import { selectAtom } from "jotai/utils"
import { lazy, Suspense, useMemo } from "react"
import { HelpTooltip } from "@/components/help-tooltip"
import { useTheme } from "@/components/providers/theme-provider"
import { Avatar, AvatarGroup, AvatarGroupCount, AvatarImage } from "@/components/ui/base-ui/avatar"
import { Button } from "@/components/ui/base-ui/button"
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerTrigger,
  DrawerTitle,
  DrawerDescription,
  DrawerHeader,
} from "@/components/ui/base-ui/drawer"
import { configAtom } from "@/utils/atoms/config"
import { FEATURE_KEYS, FEATURE_PROVIDER_DEFS } from "@/utils/constants/feature-providers"
import { getSelectionToolbarActions } from "@/utils/custom-actions"
import { i18n } from "@/utils/i18n"
import { getProviderLogo, getProviderName } from "@/utils/providers/provider-display"
import { getSelectableProvidersForCapability } from "@/utils/providers/provider-registry"

const loadProviderSelectors = () =>
  import("@/components/llm-providers/feature-provider-selector-list").then((module) => ({
    default: module.FeatureProviderSelectorList,
  }))
const ProviderSelectors = lazy(loadProviderSelectors)
const warmProviderSelectors = () => {
  void loadProviderSelectors().catch(() => {})
}

const VISIBLE_PROVIDER_COUNT = 2

interface SelectedProviderSlot {
  provider: ProviderSelectorOption
  capability: ProviderCapability
}

const providerSummaryInputAtom = selectAtom(
  configAtom,
  (config) => ({
    providers: config.providersConfig,
    assignments: [
      ...FEATURE_KEYS.map((capability) => ({
        capability: capability as ProviderCapability,
        providerId: FEATURE_PROVIDER_DEFS[capability].getProviderId(config),
      })),
      ...getSelectionToolbarActions(config.selectionToolbar)
        .filter((action) => action.enabled !== false)
        .map((action) => ({ capability: "customAction" as const, providerId: action.providerId })),
    ],
  }),
  dequal,
)

function getSelectedProviderOptions(
  assignments: { capability: ProviderCapability; providerId: string }[],
  providersConfig: ProvidersConfig,
): SelectedProviderSlot[] {
  const selectedProviders: SelectedProviderSlot[] = []

  const addProvider = (capability: ProviderCapability, providerId: string) => {
    const selectedProvider = getSelectableProvidersForCapability(capability, providersConfig).find(
      (providerOption) => providerOption.id === providerId,
    )
    if (!selectedProvider) {
      return
    }

    selectedProviders.push({ provider: selectedProvider, capability })
  }

  for (const { capability, providerId } of assignments) addProvider(capability, providerId)

  return selectedProviders
}

function ProviderAvatarSummary({ slots }: { slots: SelectedProviderSlot[] }) {
  const { theme } = useTheme()

  const uniqueSlots = [...new Map(slots.map((slot) => [slot.provider.id, slot])).values()]
  const visibleSlots = uniqueSlots.slice(0, VISIBLE_PROVIDER_COUNT)
  const remainingCount = uniqueSlots.length - visibleSlots.length

  return (
    <AvatarGroup>
      {visibleSlots.map(({ provider }) => {
        const name = getProviderName(provider)
        return (
          <Avatar
            key={provider.id}
            size="sm"
            className="items-center justify-center bg-white dark:bg-muted"
          >
            <AvatarImage
              src={getProviderLogo(provider, theme)}
              alt={name}
              className="size-3.5 rounded-none object-contain"
            />
          </Avatar>
        )
      })}
      {remainingCount > 0 && <AvatarGroupCount>{`+${remainingCount}`}</AvatarGroupCount>}
    </AvatarGroup>
  )
}

export default function ProvidersField() {
  const { assignments, providers } = useAtomValue(providerSummaryInputAtom)

  const selectedProviders = useMemo(
    () => getSelectedProviderOptions(assignments, providers),
    [assignments, providers],
  )

  return (
    <Drawer>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-medium">
          {i18n.t("popup.providers.title")}
          <HelpTooltip>{i18n.t("popup.providers.description")}</HelpTooltip>
        </span>
        <DrawerTrigger
          onPointerEnter={warmProviderSelectors}
          onFocus={warmProviderSelectors}
          render={
            <Button
              type="button"
              variant="ghost"
              className="max-w-[180px] min-w-0 gap-1.5 px-1.5"
              aria-label={i18n.t("popup.providers.open")}
            />
          }
        >
          <ProviderAvatarSummary slots={selectedProviders} />
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {selectedProviders.length
              ? [
                  ...new Set(selectedProviders.map(({ provider }) => getProviderName(provider))),
                ].join(", ")
              : i18n.t("popup.state.emptyProviders")}
          </span>
          <IconChevronRight
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </DrawerTrigger>
      </div>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{i18n.t("popup.providers.title")}</DrawerTitle>
          <DrawerDescription>{i18n.t("popup.providers.description")}</DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="p-4" data-base-ui-swipe-ignore="">
          <Suspense fallback={<p role="status">{i18n.t("ui.loading")}</p>}>
            <ProviderSelectors providerSelectorTriggerSize="sm" />
          </Suspense>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  )
}

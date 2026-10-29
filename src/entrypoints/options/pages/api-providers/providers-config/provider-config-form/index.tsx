import type { APIProviderConfig, ProvidersConfig } from "@/types/config/provider"
import { dequal } from "dequal"
import { useAtomValue, useSetAtom, useStore } from "jotai"
import { useEffect, useState } from "react"
import {
  AutosaveBoundary,
  requestEditorNavigationAtom,
} from "@/components/form/autosave-navigation"
import { toAutosaveSession } from "@/components/form/use-autosave"
import { isAPIProviderConfig, isLLMProvider, isTranslateProvider } from "@/types/config/provider"
import {
  configAtom,
  configFieldsAtomMap,
  writeConfigAtom,
  mergeWithArrayOverwrite,
} from "@/utils/atoms/config"
import { patchProviderConfigAtom } from "@/utils/atoms/entity-config"
import { providerConfigAtom } from "@/utils/atoms/provider"
import { clearProviderAssignments, clearSelectionToolbarProvider } from "@/utils/config/helpers"
import {
  buildFeatureProviderPatch,
  FEATURE_KEYS,
  FEATURE_PROVIDER_DEFS,
} from "@/utils/constants/feature-providers"
import { EntityEditor } from "../../../../components/entity-editor"
import { selectedProviderIdAtom } from "../atoms"
import { CustomProviderEditor, ProviderEditor, useProviderForm } from "../provider-editor"
import { duplicateProvider } from "../utils"

export function ProviderConfigForm() {
  const selectedProviderId = useAtomValue(selectedProviderIdAtom)
  const providerConfig = useAtomValue(providerConfigAtom(selectedProviderId ?? ""))

  const [lastProvider, setLastProvider] = useState<APIProviderConfig | undefined>(undefined)
  if (
    providerConfig &&
    isAPIProviderConfig(providerConfig) &&
    !dequal(providerConfig, lastProvider)
  ) {
    setLastProvider(providerConfig)
  }
  const editorProvider =
    providerConfig && isAPIProviderConfig(providerConfig)
      ? providerConfig
      : lastProvider?.id === selectedProviderId
        ? lastProvider
        : undefined
  if (!editorProvider) {
    return null
  }

  return <EditableProviderConfig key={editorProvider.id} providerConfig={editorProvider} />
}

function EditableProviderConfig({ providerConfig }: { providerConfig: APIProviderConfig }) {
  const store = useStore()
  const requestNavigation = useSetAtom(requestEditorNavigationAtom)
  const setSelectedProviderId = useSetAtom(selectedProviderIdAtom)
  const currentProviderConfig = useAtomValue(providerConfigAtom(providerConfig.id))
  const setAllProvidersConfig = useSetAtom(configFieldsAtomMap.providersConfig)
  const setConfig = useSetAtom(writeConfigAtom)
  const config = useAtomValue(configAtom)
  // Decides which built-in tiers count as usable below. Unknown status reads as
  // usable, so an unreachable status endpoint never traps someone with a
  // credential they want gone.

  const patchProvider = useSetAtom(patchProviderConfigAtom)
  const { form, autosave } = useProviderForm(providerConfig, async (_snapshot, changes) => {
    await patchProvider({ id: providerConfig.id, changes })
  })

  useEffect(() => {
    autosave.reconcile(
      currentProviderConfig && isAPIProviderConfig(currentProviderConfig)
        ? currentProviderConfig
        : undefined,
    )
  }, [currentProviderConfig, autosave])

  const chooseNextProviderConfig = (providersConfig: ProvidersConfig) => providersConfig[0]

  const handleDuplicate = async () => {
    await requestNavigation(async () => {
      const latest = store.get(providerConfigAtom(providerConfig.id))
      if (!latest || !isAPIProviderConfig(latest)) return
      await duplicateProvider(
        latest,
        store.get(configFieldsAtomMap.providersConfig),
        setAllProvidersConfig,
        setSelectedProviderId,
      )
    })
  }

  const handleDelete = async () => {
    await autosave.discard()
    const updatedAllProviders = store
      .get(configFieldsAtomMap.providersConfig)
      .filter((provider) => provider.id !== providerConfig.id)

    const updatedSelectionToolbar = clearSelectionToolbarProvider(providerConfig.id, config)
    const fallbacks = clearProviderAssignments(providerConfig.id, config)
    const patch = mergeWithArrayOverwrite(
      { selectionToolbar: updatedSelectionToolbar },
      buildFeatureProviderPatch(fallbacks),
    )

    await setConfig({ ...patch, providersConfig: updatedAllProviders })
    const nextProvider = chooseNextProviderConfig(updatedAllProviders)
    await setSelectedProviderId(nextProvider?.id)
  }

  const providerType = providerConfig.provider
  const hasTranslationModelFields = isTranslateProvider(providerType) && isLLMProvider(providerType)
  const hasAdvancedFields = isLLMProvider(providerType)
  const hasAssignments =
    hasAdvancedFields ||
    FEATURE_KEYS.some((featureKey) => FEATURE_PROVIDER_DEFS[featureKey].isProvider(providerType))

  return (
    <AutosaveBoundary session={toAutosaveSession(autosave)}>
      <CustomProviderEditor.Provider
        providerConfig={providerConfig}
        form={form}
        duplicate={handleDuplicate}
        delete={handleDelete}
      >
        <ProviderEditor.Form>
          <EntityEditor.Root>
            <EntityEditor.Body>
              <ProviderEditor.ConfigHeader />
              <ProviderEditor.NameField />
              <ProviderEditor.DescriptionField />
              <ProviderEditor.ConnectionFields />
              <ProviderEditor.ProviderSpecificFields />
              {hasTranslationModelFields && <ProviderEditor.TranslationModelFields />}
              {hasAssignments && (
                <ProviderEditor.Assignments>
                  <ProviderEditor.CompatibleFeatureAssignments />
                  <></>
                  <ProviderEditor.CustomActionAssignments />
                </ProviderEditor.Assignments>
              )}
              {hasAdvancedFields && <ProviderEditor.AdvancedFields />}
            </EntityEditor.Body>
            <EntityEditor.Footer>
              <ProviderEditor.DuplicateButton />
              <ProviderEditor.DeleteButton />
            </EntityEditor.Footer>
          </EntityEditor.Root>
        </ProviderEditor.Form>
      </CustomProviderEditor.Provider>
    </AutosaveBoundary>
  )
}

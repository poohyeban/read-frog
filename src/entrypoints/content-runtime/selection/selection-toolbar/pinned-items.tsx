import { useAtomValue } from "jotai"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { getSelectionToolbarActions } from "@/utils/custom-actions"
import { SelectionToolbarCustomActionTrigger } from "./custom-action-button/custom-action-trigger"
import { TranslateButton } from "./translate-button"
export function SelectionToolbarPinnedItems() {
  const config = useAtomValue(configFieldsAtomMap.selectionToolbar)
  return (
    <>
      {config.features.translate.enabled && <TranslateButton />}
      {getSelectionToolbarActions(config)
        .filter((action) => action.enabled !== false)
        .map((action) => (
          <SelectionToolbarCustomActionTrigger key={action.id} action={action} />
        ))}
    </>
  )
}

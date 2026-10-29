import type { ThinkingSnapshot } from "@/types/background-stream"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { FallbackFieldList } from "@/components/layout-host/fallback-field-list"
import { Thinking } from "@/components/thinking"
import { SelectionSourceContent } from "@/components/ui/selection-popover/selection-source-content"
export function CustomActionContent({
  action,
  status,
  selectionContent,
  value,
  thinking,
}: {
  action: SelectionToolbarCustomAction | null
  status: "idle" | "streaming" | "done" | "error"
  selectionContent: string | null | undefined
  value: Record<string, unknown> | null
  thinking: ThinkingSnapshot | null
}) {
  return (
    <div className="p-4">
      <SelectionSourceContent
        text={selectionContent}
        emptyPlaceholder="—"
        separatorClassName="mb-4"
      />
      {thinking && <Thinking status={thinking.status} content={thinking.text} />}
      {action && (value !== null || status === "streaming") && (
        <FallbackFieldList outputSchema={action.outputSchema} value={value} status={status} />
      )}
    </div>
  )
}

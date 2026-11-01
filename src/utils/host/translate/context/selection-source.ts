import type { ContextSource } from "./types"
import { resolveContextScope } from "./scope-resolver"

/** Captured ranges are only provenance. Never read the later live selection or
 * expand a range across unrelated feed items into a document-wide context. */
export function contextSourceForSelection(
  selection:
    | {
        text: string
        ranges: readonly { startContainer: Node; endContainer: Node }[]
        textControl?: unknown
      }
    | undefined,
  capturedContext?: string,
): ContextSource {
  const text = capturedContext || selection?.text || ""
  const first = selection?.ranges[0]?.startContainer
  if (!first?.isConnected || selection?.textControl) return { kind: "selection", text }
  const scope = resolveContextScope({ source: first })
  for (const range of selection?.ranges ?? []) {
    if (
      !range.startContainer.isConnected ||
      !range.endContainer.isConnected ||
      resolveContextScope({ source: range.startContainer }).id !== scope.id ||
      resolveContextScope({ source: range.endContainer }).id !== scope.id
    )
      return { kind: "selection", text }
  }
  return { kind: "selection", source: first, text }
}

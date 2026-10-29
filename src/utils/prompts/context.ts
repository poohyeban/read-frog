/** Shared by trusted extension request producers and consumers; no UI imports. */
export function normalizePromptContextValue(
  value: string | null | undefined,
): string | null | undefined {
  return typeof value === "string" && value.trim() === "" ? null : value
}

export function getProviderHeaders(
  record?: Readonly<Record<string, unknown>>,
): Record<string, string> | undefined {
  if (!record) {
    return undefined
  }

  const compacted = Object.fromEntries(
    Object.entries(record)
      .filter((entry): entry is [string, string] => {
        const [, value] = entry
        return typeof value === "string" && value !== ""
      })
      .map(([key, value]) => [
        key.toLowerCase() === "authorization"
          ? "Authorization"
          : key.toLowerCase() === "x-goog-api-key"
            ? "x-goog-api-key"
            : key.toLowerCase() === "openai-organization"
              ? "OpenAI-Organization"
              : key.toLowerCase() === "openai-project"
                ? "OpenAI-Project"
                : key,
        value,
      ]),
  )

  return Object.keys(compacted).length > 0 ? compacted : undefined
}

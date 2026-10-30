export interface LocaleTree {
  [key: string]: string | LocaleTree
}

/**
 * Convert WXT-style positional substitutions to i18next interpolation, applied to
 * every string leaf when a locale is loaded:
 *   - `$$`      → literal `$`   (WXT escape; none currently in the YAML, handled anyway)
 *   - `$1`..`$9`→ `{{0}}`..`{{8}}` (0-indexed to match the facade's array mapping)
 *
 * Intentionally left untouched:
 *   - existing named tokens like `{{targetLanguage}}` (LLM prompt templates; no `$`)
 *   - Chrome context-menu placeholders like `%s`
 */
function convertPlaceholders(value: string): string {
  return value.replace(/\$\$|\$(\d)/g, (_match, digit: string | undefined) =>
    digit === undefined ? "$" : `{{${Number(digit) - 1}}}`,
  )
}

export function convertTree(node: LocaleTree): LocaleTree {
  const out: LocaleTree = {}
  for (const [key, val] of Object.entries(node)) {
    out[key] = typeof val === "string" ? convertPlaceholders(val) : convertTree(val)
  }
  return out
}

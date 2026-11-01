import type {
  SelectionToolbarCustomAction,
  SelectionToolbarCustomActionOutputField,
} from "@/types/config/selection-toolbar"
import { contextData, CONTEXT_DATA_RULE } from "@/utils/prompts/context-data"

export interface SelectionToolbarCustomActionPromptTokens {
  selection: string
  paragraphs: string
  targetLanguage: string
  webTitle: string
  webUrl: string
  webContent: string
}

export function replaceSelectionToolbarCustomActionPromptTokens(
  prompt: string,
  tokens: SelectionToolbarCustomActionPromptTokens,
) {
  return prompt.replace(
    /\{\{(selection|paragraphs|targetLanguage|webTitle|webUrl|webContent)\}\}/g,
    (_, name: keyof SelectionToolbarCustomActionPromptTokens) => {
      const value = tokens[name]
      return value && (name === "webTitle" || name === "webUrl" || name === "webContent")
        ? contextData(name, value)
        : value
    },
  )
}

export type StructuredOutputField = Pick<
  SelectionToolbarCustomActionOutputField,
  "name" | "type" | "description"
>

function formatYamlMultiline(value: string) {
  return value
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}

function formatStructuredOutputField(
  field: StructuredOutputField,
  tokens: SelectionToolbarCustomActionPromptTokens,
) {
  const resolvedDescription = replaceSelectionToolbarCustomActionPromptTokens(
    field.description,
    tokens,
  ).trim()
  const descriptionBlock = resolvedDescription
    ? `  description: |-\n${formatYamlMultiline(resolvedDescription)}`
    : '  description: ""'

  return [
    `- key: ${JSON.stringify(field.name)}`,
    `  type: ${field.type}`,
    "  nullable: true",
    descriptionBlock,
  ].join("\n")
}

export function buildStructuredOutputFieldList(
  outputSchema: StructuredOutputField[],
  tokens: SelectionToolbarCustomActionPromptTokens,
) {
  return outputSchema.map((field) => formatStructuredOutputField(field, tokens)).join("\n")
}

function buildStructuredOutputContract(
  outputSchema: StructuredOutputField[],
  tokens: SelectionToolbarCustomActionPromptTokens,
) {
  const fieldsAndTypes = buildStructuredOutputFieldList(outputSchema, tokens)

  return `## Structured Output Contract
Return exactly one JSON object and nothing else.

### Required Keys and Types
${fieldsAndTypes}

### Hard Requirements
1. Include every required key exactly once.
2. Do not add any extra keys.
3. Use the exact key names shown above.
4. Output valid JSON only. Use double quotes for keys and string values.
5. Do not wrap the JSON in markdown or code fences.
6. If a value is unknown, use null.
7. Number fields must be JSON numbers, never quoted strings.
`
}

export function buildSelectionToolbarCustomActionSystemPrompt(
  prompt: string,
  tokens: SelectionToolbarCustomActionPromptTokens,
  outputSchema: StructuredOutputField[],
) {
  const resolvedPrompt = replaceSelectionToolbarCustomActionPromptTokens(prompt, tokens).trim()
  const contract = buildStructuredOutputContract(outputSchema, tokens)

  return `${resolvedPrompt ? `${resolvedPrompt}\n\n` : ""}${contract}\n${CONTEXT_DATA_RULE}`
}

export const CUSTOM_ACTION_CONTEXT_CHAR_LIMIT = 2000

export function truncateContextTextForCustomAction(
  contextText: string,
  limit = CUSTOM_ACTION_CONTEXT_CHAR_LIMIT,
) {
  return contextText.slice(0, limit)
}

export function getCustomActionContextRequirements(
  action?: Pick<SelectionToolbarCustomAction, "systemPrompt" | "prompt" | "outputSchema"> | null,
) {
  const template = [
    action?.systemPrompt,
    action?.prompt,
    ...(action?.outputSchema.map((field) => field.description) ?? []),
  ].join("\n")
  return {
    title: template.includes("{{webTitle}}"),
    description: false,
    content: template.includes("{{webContent}}"),
    summary: false,
  }
}

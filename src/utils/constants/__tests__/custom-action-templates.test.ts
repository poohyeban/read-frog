import { readFile } from "node:fs/promises"
import { DEFAULT_LAYOUT } from "@read-frog/layout-engine/presets"
import { describe, expect, it } from "vitest"
import { selectionToolbarCustomActionsSchema } from "@/types/config/selection-toolbar"
import { SUPPORTED_UI_LOCALES } from "@/utils/i18n/locales"
import { buildDictionaryActionLayout } from "@/utils/layout-host/slots"
import { getSelectionToolbarCustomActionTokenCellText } from "../custom-action"
import { CUSTOM_ACTION_TEMPLATES } from "../custom-action-templates"

function createFromTemplate(id: string) {
  const template = CUSTOM_ACTION_TEMPLATES.find((candidate) => candidate.id === id)
  if (!template) throw new Error(`missing template ${id}`)
  return template.createAction("openai-default")
}

// A locale's `blank.prompt` block, its indentation removed. i18n is mocked in
// tests, so the text is read from the locale file.
async function readBlankPrompt(locale: string): Promise<string | undefined> {
  const text = await readFile(new URL(`../../../locales/${locale}.yml`, import.meta.url), "utf8")
  const block = /^ {8}blank:\n(?: {10}.*\n)*? {10}prompt: \|-\n((?: {12}.*\n)+)/m.exec(text)?.[1]
  return block?.replace(/^ {12}/gm, "").trimEnd()
}

// A locale's dictionary preset as text: the system prompt (indentation
// removed) and the Memory Tips field's name.
async function readDictionaryMemoryTips(locale: string) {
  const text = await readFile(new URL(`../../../locales/${locale}.yml`, import.meta.url), "utf8")
  const block = /^ {8}dictionary:\n((?: {10}.*\n|\n)+)/m.exec(text)?.[1] ?? ""
  const systemPrompt = /^ {10}systemPrompt: \|-\n((?: {12}.*\n|\n)+)/m
    .exec(block)?.[1]
    ?.replace(/^ {12}/gm, "")
  const name = /^ {10}fieldMemoryTips: "(.*)"$/m.exec(block)?.[1]
  return { systemPrompt, name }
}

describe("dictionary template memory tips prompt", () => {
  // The prompt names the field the model must fill, so a field renamed in one
  // locale without its prompt would leave the model guessing.
  it.each(SUPPORTED_UI_LOCALES)("shows the field by its own name in %s", async (locale) => {
    const { systemPrompt, name } = await readDictionaryMemoryTips(locale)

    expect(name).toEqual(expect.any(String))
    expect(systemPrompt).toMatch(/^12\. /m)
    // Both worked examples end with a two-tip answer: the field's label, then
    // one tip per line. A literal "\n" in an example gets copied into answers,
    // where it is no line break.
    const lines = systemPrompt?.split("\n") ?? []
    const labels = lines.flatMap((line, i) => (/^- (.*)[:：]$/.exec(line)?.[1] === name ? [i] : []))
    expect(labels).toHaveLength(2)
    for (const i of labels) {
      expect(lines.slice(i + 1, i + 3)).toEqual([
        expect.stringMatching(/^ {2}\S/),
        expect.stringMatching(/^ {2}\S/),
      ])
    }
    expect(systemPrompt).not.toContain("\\n")
  })
})

describe("blank custom action template prompt", () => {
  // New actions default to the Built-in AI, whose contract requires a prompt:
  // an empty one fails the request before it is sent.

  it.each(SUPPORTED_UI_LOCALES)(
    "hands the model the selection and its context in %s",
    async (locale) => {
      const prompt = await readBlankPrompt(locale)

      for (const token of ["selection", "paragraphs", "targetLanguage"] as const) {
        expect(prompt).toContain(getSelectionToolbarCustomActionTokenCellText(token))
      }
    },
  )
})

describe("custom action template layouts", () => {
  it("gives the blank template the default field list", () => {
    expect(createFromTemplate("blank").layout).toBe(DEFAULT_LAYOUT)
  })

  it("gives the dictionary preset the card built for its own fields", () => {
    const action = createFromTemplate("dictionary")

    expect(action.layout).toEqual(expect.any(String))
    expect(action.layout).toBe(buildDictionaryActionLayout(action.outputSchema))
    expect(action.layout).not.toBe(DEFAULT_LAYOUT)
  })

  it("creates schema-valid actions", () => {
    const actions = CUSTOM_ACTION_TEMPLATES.map((template) =>
      template.createAction("openai-default"),
    )

    expect(selectionToolbarCustomActionsSchema.safeParse(actions).success).toBe(true)
  })
})

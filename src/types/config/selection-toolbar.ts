import { langCodeISO6393Schema } from "@read-frog/definitions"
import { z } from "zod"
import { isBuiltInActionId } from "@/utils/constants/custom-action"
import { shortcutSchema } from "./shortcut"

// Upper bound (UTF-16 code units) of a custom action's HTML layout. NEVER lower
// it: an older build that reads a config holding a longer layout fails schema
// validation, falls back to DEFAULT_CONFIG and overwrites the synced remote
// copy. Raising it is fine only together with a CONFIG_SCHEMA_VERSION bump, so
// older builds refuse the newer config instead of choking on it.
export const MAX_CUSTOM_ACTION_LAYOUT_LENGTH = 32768

// Upper bound (UTF-16 code units) of each text in a custom action's sample
// data. NEVER lower it, for the reason given above.
export const MAX_CUSTOM_ACTION_SAMPLE_TEXT_LENGTH = 32768

// The contract's field-type enum is the source of truth: these values ride the
// wire to hostedAi.customAction unchanged. Only the enum is shared — length
// caps and strictness stay hosted-only so BYOK actions are not constrained.
export const selectionToolbarCustomActionOutputTypeSchema = z.enum(["string", "number"])

export const selectionToolbarCustomActionOutputFieldSchema = z.object({
  id: z.string().nonempty(),
  name: z.string().trim().min(1),
  type: selectionToolbarCustomActionOutputTypeSchema,
  description: z.string(),
  // Where the value comes from: the model, unless this is "selection", the
  // text the reader selected, which then rides along with the answer (so
  // "save to notebase" keeps it next to what the model wrote about it). A
  // selection field is never asked of the model; it is always text. Added in
  // v111, which older builds refuse rather than drop it and turn the field
  // into one the model writes.
  source: z.literal("selection").optional(),
})

// What the layout preview renders an action's result with: the text the
// reader selected, the language the answer is written for, and each output
// field's value by field id (an id survives a rename). Values are text, the
// way a model answers; the layout scope converts a number field's text.
export const selectionToolbarCustomActionSampleDataSchema = z.object({
  selection: z.string().max(MAX_CUSTOM_ACTION_SAMPLE_TEXT_LENGTH),
  targetCode: langCodeISO6393Schema,
  values: z.record(z.string(), z.string().max(MAX_CUSTOM_ACTION_SAMPLE_TEXT_LENGTH)),
})

export const selectionToolbarBuiltInActionStateSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().nonempty(),
  shortcut: shortcutSchema.optional(),
})

export const selectionToolbarBuiltInActionsSchema = z.object({
  dictionary: selectionToolbarBuiltInActionStateSchema,
  // `.default()` is load-bearing: a config stored before v104 still parses in
  // UI contexts that load ahead of the background migration, instead of
  // falling back to DEFAULT_CONFIG and writing that over the user's settings.
  sentenceAnalysis: selectionToolbarBuiltInActionStateSchema.default(() => ({
    enabled: true,
    providerId: "openai-default",
  })),
  // For the same reason as above. Off: a config stored before v105 has not
  // been through v106 either, which turns it on and unpins it, so it must not
  // land on the toolbar in the meantime.
  improveWriting: selectionToolbarBuiltInActionStateSchema.default(() => ({
    enabled: false,
    providerId: "openai-default",
  })),
})

export const selectionToolbarCustomActionSchema = z
  .object({
    id: z.string().nonempty(),
    name: z.string().nonempty(),
    enabled: z.boolean().optional(),
    icon: z.string(),
    providerId: z.string().nonempty(),
    systemPrompt: z.string(),
    prompt: z.string(),
    outputSchema: z.array(selectionToolbarCustomActionOutputFieldSchema).min(1),
    shortcut: shortcutSchema.optional(),
    layout: z.string().max(MAX_CUSTOM_ACTION_LAYOUT_LENGTH).optional(),
    sampleData: selectionToolbarCustomActionSampleDataSchema.optional().catch(undefined),
  })
  .superRefine((action, ctx) => {
    const nameSet = new Set<string>()
    const outputFieldIds = new Set<string>()

    action.outputSchema.forEach((field, index) => {
      if (nameSet.has(field.name)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate output schema name "${field.name}".`,
          path: ["outputSchema", index, "name"],
        })
        return
      }
      nameSet.add(field.name)
      outputFieldIds.add(field.id)
    })
  })

export const selectionToolbarCustomActionsSchema = z
  .array(selectionToolbarCustomActionSchema)
  .superRefine((actions, ctx) => {
    const idSet = new Set<string>()
    actions.forEach((action, index) => {
      if (isBuiltInActionId(action.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Action id "${action.id}" is reserved for a built-in action.`,
          path: [index, "id"],
        })
      }

      if (idSet.has(action.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate action id "${action.id}"`,
          path: [index, "id"],
        })
      }
      idSet.add(action.id)
    })

    const nameSet = new Set<string>()
    actions.forEach((action, index) => {
      if (nameSet.has(action.name)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate action name "${action.name}"`,
          path: [index, "name"],
        })
      }
      nameSet.add(action.name)
    })
  })

// TODO: make these vairbale shorter by deleteing SelectionToolbar or "selectionToolbar"
export type SelectionToolbarCustomActionOutputType = z.infer<
  typeof selectionToolbarCustomActionOutputTypeSchema
>
export type SelectionToolbarCustomActionOutputField = z.infer<
  typeof selectionToolbarCustomActionOutputFieldSchema
>
export type SelectionToolbarCustomActionSampleData = z.infer<
  typeof selectionToolbarCustomActionSampleDataSchema
>

export type SelectionToolbarBuiltInActionState = z.infer<
  typeof selectionToolbarBuiltInActionStateSchema
>
export type SelectionToolbarBuiltInActions = z.infer<typeof selectionToolbarBuiltInActionsSchema>
export type SelectionToolbarCustomAction = z.infer<typeof selectionToolbarCustomActionSchema>

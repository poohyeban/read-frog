import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { i18n } from "@/utils/i18n"
import { createOutputSchemaField, createSelectionOutputField } from "./custom-action"

const T_PREFIX = "options.selectionToolbar.customActions.templates"
const SA_PREFIX = `${T_PREFIX}.sentenceAnalysis`

// An action as a preset defines it, before its card is built: the built-in
// actions rename the field ids first and build the card for those.
export type CustomActionDefinition = SelectionToolbarCustomAction

export function createDictionaryDefinition(providerId: string): CustomActionDefinition {
  return {
    id: getRandomUUID(),
    name: i18n.t(`${T_PREFIX}.dictionary.name`),
    enabled: true,
    icon: "streamline-color:dictionary-language-book-flat",
    providerId,
    systemPrompt: i18n.t(`${T_PREFIX}.dictionary.systemPrompt`),
    prompt: i18n.t(`${T_PREFIX}.dictionary.prompt`),
    outputSchema: [
      createOutputSchemaField(
        i18n.t(`${T_PREFIX}.dictionary.fieldTerm`),
        "string",
        i18n.t(`${T_PREFIX}.dictionary.fieldTermDescription`),
        "dictionary-term",
      ),
      createOutputSchemaField(
        i18n.t(`${T_PREFIX}.dictionary.fieldPhonetic`),
        "string",
        i18n.t(`${T_PREFIX}.dictionary.fieldPhoneticDescription`),
        "dictionary-phonetic",
      ),
      createOutputSchemaField(
        i18n.t(`${T_PREFIX}.dictionary.fieldPartOfSpeech`),
        "string",
        i18n.t(`${T_PREFIX}.dictionary.fieldPartOfSpeechDescription`),
        "dictionary-part-of-speech",
      ),
      createOutputSchemaField(
        i18n.t(`${T_PREFIX}.dictionary.fieldDefinition`),
        "string",
        i18n.t(`${T_PREFIX}.dictionary.fieldDefinitionDescription`),
        "dictionary-definition",
      ),
      createOutputSchemaField(
        i18n.t(`${T_PREFIX}.dictionary.fieldSentence`),
        "string",
        i18n.t(`${T_PREFIX}.dictionary.fieldSentenceDescription`),
        "dictionary-context",
      ),
      // Where the term stands in the sentence, as annotations for the card
      // to mark (a JSON array of {"text": …} quotes).
      createOutputSchemaField(
        i18n.t(`${T_PREFIX}.dictionary.fieldSentenceTerm`),
        "string",
        i18n.t(`${T_PREFIX}.dictionary.fieldSentenceTermDescription`),
        "dictionary-context-term",
      ),
      createOutputSchemaField(
        i18n.t(`${T_PREFIX}.dictionary.fieldSentenceTranslation`),
        "string",
        i18n.t(`${T_PREFIX}.dictionary.fieldSentenceTranslationDescription`),
        "dictionary-context-translation",
      ),
      // Plain text, one tip per line, and empty when nothing helps: a JSON
      // array here lost every tip on some answers (models cut the inner string

      // last field: after this long value, deepseek-v4-flash broke the end of
      // its JSON on 4% of answers; a short Difficulty last keeps it closing.
      createOutputSchemaField(
        i18n.t(`${T_PREFIX}.dictionary.fieldMemoryTips`),
        "string",
        i18n.t(`${T_PREFIX}.dictionary.fieldMemoryTipsDescription`),
        "dictionary-memory-tips",
      ),
      createOutputSchemaField(
        i18n.t(`${T_PREFIX}.dictionary.fieldDifficulty`),
        "string",
        i18n.t(`${T_PREFIX}.dictionary.fieldDifficultyDescription`),
        "dictionary-difficulty",
      ),
    ],
  }
}

// The prompt is English in every UI language: its wording is what keeps
// models' annotations valid and consistent (tested across models), so it is
// not translated. It names the two fields, whose names are localized, and asks
// for notes and the translation in the target language.
export function createSentenceAnalysisDefinition(providerId: string): CustomActionDefinition {
  const annotations = i18n.t(`${SA_PREFIX}.fieldAnnotations`)
  const translation = i18n.t(`${SA_PREFIX}.fieldTranslation`)
  return {
    id: getRandomUUID(),
    name: i18n.t(`${SA_PREFIX}.name`),
    enabled: true,
    icon: "streamline-color:search-visual-flat",
    providerId,
    systemPrompt: i18n.t(`${SA_PREFIX}.systemPrompt`, [annotations, translation]),
    prompt: i18n.t(`${SA_PREFIX}.prompt`),
    // The sentence itself comes first: it is the selection, not something the

    // cannot be drawn without it) and it names the note. Field types are only
    // string and number, so the annotations travel as a JSON array inside a
    // string field. Each one quotes a span of the sentence; the card parses
    // them and anchors the quotes onto it.
    outputSchema: [
      createSelectionOutputField(
        i18n.t(`${SA_PREFIX}.fieldSentence`),
        "sentence-analysis-sentence",
      ),
      createOutputSchemaField(
        annotations,
        "string",
        i18n.t(`${SA_PREFIX}.fieldAnnotationsDescription`),
        "sentence-analysis-annotations",
      ),
      createOutputSchemaField(
        translation,
        "string",
        i18n.t(`${SA_PREFIX}.fieldTranslationDescription`),
        "sentence-analysis-translation",
      ),
    ],
  }
}

// Like Sentence Analysis, the prompt and the field descriptions are English in
// every UI language, and name the fields, whose names are localized. The model
// judges the setting first (the first field it writes), then marks the
// selection and rewrites it for that setting, writing its words in the target
// language.

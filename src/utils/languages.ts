import { z } from "zod"
import { iso6391, languageNames, nativeNames, rtlCodes } from "./language-data"

export type LangCodeISO6393 = keyof typeof languageNames
export type LangCodeISO6391 = (typeof iso6391)[keyof typeof iso6391]
export const LANG_CODE_TO_EN_NAME = languageNames
export const LANG_CODE_TO_LOCALE_NAME = nativeNames
export const LANG_CODE_ISO6393_OPTIONS = Object.keys(languageNames) as [
  LangCodeISO6393,
  ...LangCodeISO6393[],
]
export const ISO6393_TO_6391: Partial<Record<LangCodeISO6393, LangCodeISO6391>> = iso6391
export const LANG_CODE_ISO6391_OPTIONS = [...new Set(Object.values(iso6391))]
export const LOCALE_TO_ISO6393 = Object.fromEntries(
  Object.entries(iso6391)
    .reverse()
    .map(([code, locale]) => [locale, code]),
) as Partial<Record<LangCodeISO6391, LangCodeISO6393>>
export const RTL_LANG_CODES: readonly LangCodeISO6393[] = rtlCodes
export const langCodeISO6393Schema = z.enum(LANG_CODE_ISO6393_OPTIONS)
export const langLevel = z.enum(["beginner", "intermediate", "advanced"])
export type LangLevel = z.infer<typeof langLevel>

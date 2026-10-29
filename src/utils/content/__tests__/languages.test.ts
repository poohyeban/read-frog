import { describe, expect, it } from "vitest"
import {
  LANG_CODE_ISO6393_OPTIONS,
  LANG_CODE_TO_EN_NAME,
  ISO6393_TO_6391,
  langCodeISO6393Schema,
} from "@/utils/languages"
import { resolveLanguageCodeFromLocale } from "../page-language"

describe("independent language data", () => {
  it("preserves the 179 GPL locale languages and validates stored choices", () => {
    expect(LANG_CODE_ISO6393_OPTIONS).toHaveLength(179)
    for (const code of LANG_CODE_ISO6393_OPTIONS) {
      expect(langCodeISO6393Schema.parse(code)).toBe(code)
      expect(LANG_CODE_TO_EN_NAME[code]).toBeTruthy()
    }
    expect(langCodeISO6393Schema.safeParse("unknown").success).toBe(false)
  })
  it("resolves ISO and Chinese locale aliases without a remote catalog", () => {
    for (const [locale, code] of Object.entries({
      en: "eng",
      "ja-JP": "jpn",
      ar: "arb",
      fa: "pes",
      sw: "swh",
      "zh-CN": "cmn",
      "zh-TW": "cmn-Hant",
      "zh-yue": "yue",
    }))
      expect(resolveLanguageCodeFromLocale(locale)).toBe(code)
    expect(ISO6393_TO_6391.arb).toBe("ar")
  })
})

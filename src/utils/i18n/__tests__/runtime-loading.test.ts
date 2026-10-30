import { describe, expect, it, vi } from "vitest"
import { convertTree } from "../convert"
const loader = vi.hoisted(() => ({ load: vi.fn<(locale: string) => Promise<void>>() }))
vi.unmock("@/utils/i18n")
vi.mock("../resources", () => ({
  DEFAULT_UI_LOCALE: "en",
  SUPPORTED_UI_LOCALES: ["en", "ja", "zh-CN"],
  ensureLocale: loader.load,
  resources: {
    en: {
      translation: {
        popup: { translate: "Translate" },
        test: { value: "Hello {{0}}", literal: "{{selection}} %s" },
      },
    },
    ja: { translation: { popup: { translate: "翻訳" } } },
    "zh-CN": { translation: { popup: { translate: "翻译" } } },
  },
}))
import { getUiLocale, i18n, initI18n, setUiLanguage } from "../index"

describe("runtime locale loading", () => {
  it("preserves positional substitutions, literal tokens and dollar escapes", () => {
    expect(
      convertTree({ text: "$1 / $2 / $$ / {{selection}} / %s", nested: { text: "$9" } }),
    ).toEqual({ text: "{{0}} / {{1}} / $ / {{selection}} / %s", nested: { text: "{{8}}" } })
  })
  it("keeps the current language while loading and ignores an older selection", async () => {
    loader.load.mockResolvedValue(undefined)
    await initI18n("en")
    let release!: () => void
    loader.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const old = setUiLanguage("zh-CN")
    expect(i18n.t("popup.translate")).toBe("Translate")
    await setUiLanguage("ja")
    release()
    await old
    expect(getUiLocale()).toBe("ja")
    expect(i18n.t("popup.translate")).toBe("翻訳")
  })
  it("keeps a complete previous locale after load failure and can retry", async () => {
    loader.load.mockRejectedValueOnce(new Error("chunk unavailable"))
    await expect(setUiLanguage("zh-CN")).rejects.toThrow("chunk unavailable")
    expect(getUiLocale()).toBe("ja")
    await setUiLanguage("zh-CN")
    expect(i18n.t("popup.translate")).toBe("翻译")
  })
})

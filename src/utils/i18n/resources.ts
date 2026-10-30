import type { Resource } from "i18next"
import type { SupportedUiLocale } from "./locales"
import en from "@/locales/en.yml"
import { convertTree } from "./convert"
import { getBundledResources } from "./resources-bundled"
export type { SupportedUiLocale } from "./locales"
export { DEFAULT_UI_LOCALE, SUPPORTED_UI_LOCALES } from "./locales"

// WXT replaces ENTRYPOINT at build time. HTML pages split local locale chunks;
// MV3 workers and injected scripts keep synchronous bundles (no dynamic import).
export const resources: Resource =
  import.meta.env.ENTRYPOINT === "html"
    ? { en: { translation: convertTree(en) } }
    : getBundledResources()
const pending = new Map<SupportedUiLocale, Promise<void>>()

export async function ensureLocale(locale: SupportedUiLocale): Promise<void> {
  if (resources[locale]) return
  if (import.meta.env.ENTRYPOINT !== "html") return
  const loaders = {
    az: () => import("@/locales/az.yml"),
    en: () => import("@/locales/en.yml"),
    es: () => import("@/locales/es.yml"),
    ja: () => import("@/locales/ja.yml"),
    ko: () => import("@/locales/ko.yml"),
    ru: () => import("@/locales/ru.yml"),
    tr: () => import("@/locales/tr.yml"),
    vi: () => import("@/locales/vi.yml"),
    "zh-CN": () => import("@/locales/zh-CN.yml"),
    "zh-TW": () => import("@/locales/zh-TW.yml"),
  }
  if (!pending.has(locale)) {
    pending.set(
      locale,
      loaders[locale]()
        .then(({ default: tree }) => {
          resources[locale] = { translation: convertTree(tree) }
        })
        .finally(() => pending.delete(locale)),
    )
  }
  await pending.get(locale)
}

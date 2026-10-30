import type { Resource } from "i18next"
import type { LocaleTree } from "./convert"
import type { SupportedUiLocale } from "./locales"
import az from "@/locales/az.yml"
import en from "@/locales/en.yml"
import es from "@/locales/es.yml"
import ja from "@/locales/ja.yml"
import ko from "@/locales/ko.yml"
import ru from "@/locales/ru.yml"
import tr from "@/locales/tr.yml"
import vi from "@/locales/vi.yml"
import zhCN from "@/locales/zh-CN.yml"
import zhTW from "@/locales/zh-TW.yml"
import { convertTree } from "./convert"
export function getBundledResources(): Resource {
  const rawResources: Record<SupportedUiLocale, LocaleTree> = {
    az,
    en,
    es,
    ja,
    ko,
    ru,
    tr,
    vi,
    "zh-CN": zhCN,
    "zh-TW": zhTW,
  }

  return Object.fromEntries(
    Object.entries(rawResources).map(([lng, tree]) => [lng, { translation: convertTree(tree) }]),
  )
}

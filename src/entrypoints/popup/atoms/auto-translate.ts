import { atom } from "jotai"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { sitePatternForHost, urlMatchesPattern } from "@/utils/url-pattern"
import { popupTabAtom } from "./session"

export const isCurrentSiteInPatternsAtom = atom((get) => {
  const url = get(popupTabAtom)?.url
  return (
    !!url &&
    get(configFieldsAtomMap.pageTranslation).page.autoTranslatePatterns.some((pattern) =>
      urlMatchesPattern(url, pattern),
    )
  )
})

// Atom to toggle current site in auto-translate patterns
export const toggleCurrentSiteAtom = atom(null, async (get, set, checked: boolean) => {
  const translateConfig = get(configFieldsAtomMap.pageTranslation)
  const activeTabUrl = get(popupTabAtom)?.url

  if (!activeTabUrl) return

  const currentPatterns = translateConfig.page.autoTranslatePatterns
  // The user pointed at a page, not at a pattern: "this site" means this host
  // and anything under it, which is what it has always meant here.
  const hostPattern = sitePatternForHost(new URL(activeTabUrl).hostname)

  if (checked) {
    // Add hostname to patterns if not already present
    if (!currentPatterns.some((pattern) => urlMatchesPattern(activeTabUrl, pattern))) {
      await set(configFieldsAtomMap.pageTranslation, {
        page: {
          ...translateConfig.page,
          autoTranslatePatterns: [...currentPatterns, hostPattern],
        },
      })
    }
  } else {
    // Remove patterns that match the current hostname
    const filteredPatterns = currentPatterns.filter(
      (pattern) => !urlMatchesPattern(activeTabUrl, pattern),
    )
    await set(configFieldsAtomMap.pageTranslation, {
      page: {
        ...translateConfig.page,
        autoTranslatePatterns: filteredPatterns,
      },
    })
  }
})

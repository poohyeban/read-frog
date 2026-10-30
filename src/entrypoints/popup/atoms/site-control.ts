import type { Getter, Setter } from "jotai"
import { atom } from "jotai"
import { browser } from "#imports"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { sitePatternForHost, urlMatchesPattern } from "@/utils/url-pattern"
import { popupTabAtom } from "./session"

export function isInSiteControlList(patterns: string[], url: string): boolean {
  return patterns.some((p) => urlMatchesPattern(url, p))
}

// Atom to track if current site is in patterns
export const isCurrentSiteInWhitelistAtom = atom((get) => {
  const url = get(popupTabAtom)?.url
  return !!url && isInSiteControlList(get(configFieldsAtomMap.siteControl).whitelistPatterns, url)
})
export const isCurrentSiteInBlacklistAtom = atom((get) => {
  const url = get(popupTabAtom)?.url
  return !!url && isInSiteControlList(get(configFieldsAtomMap.siteControl).blacklistPatterns, url)
})

async function toggleSiteInPatterns(
  get: Getter,
  set: Setter,
  checked: boolean,
  patternsKey: "blacklistPatterns" | "whitelistPatterns",
) {
  const siteControlConfig = get(configFieldsAtomMap.siteControl)
  const activeTabUrl = get(popupTabAtom)?.url

  if (!activeTabUrl) return

  const currentPatterns = siteControlConfig[patternsKey]
  // The user pointed at a page, not at a pattern: "this site" means this host
  // and anything under it.
  const hostPattern = sitePatternForHost(new URL(activeTabUrl).hostname)

  if (checked) {
    if (currentPatterns.some((pattern) => urlMatchesPattern(activeTabUrl, pattern))) return
    await set(configFieldsAtomMap.siteControl, {
      ...siteControlConfig,
      [patternsKey]: [...currentPatterns, hostPattern],
    })
  } else {
    const filteredPatterns = currentPatterns.filter(
      (pattern) => !urlMatchesPattern(activeTabUrl, pattern),
    )
    await set(configFieldsAtomMap.siteControl, {
      ...siteControlConfig,
      [patternsKey]: filteredPatterns,
    })
  }

  const tab = get(popupTabAtom)
  if (tab) await browser.tabs.reload(tab.id)
}

// Atom to toggle current site in whitelist patterns
export const toggleCurrentSiteInWhitelistAtom = atom(null, async (get, set, checked: boolean) => {
  await toggleSiteInPatterns(get, set, checked, "whitelistPatterns")
})

// Atom to toggle current site in blacklist patterns
export const toggleCurrentSiteInBlacklistAtom = atom(null, async (get, set, checked: boolean) => {
  await toggleSiteInPatterns(get, set, checked, "blacklistPatterns")
})

import type { ReactNode } from "react"
import i18next from "i18next"
import { useAtomValue } from "jotai"
import { Fragment, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { setUiLanguage } from "./index"

function subscribeToLanguage(onChange: () => void) {
  i18next.on("languageChanged", onChange)
  return () => i18next.off("languageChanged", onChange)
}

function getLanguage() {
  return i18next.language
}

/**
 * Applies the configured UI language to the React subtree and re-renders it on change.
 *
 * Placement: MUST sit below the jotai `Provider`/`HydrateAtoms` and `QueryClientProvider`
 * of each entrypoint (jotai recreates its store per Provider instance, so re-keying above
 * it would wipe atom state), and above the page/app content.
 *
 * Mechanism: the subtree is keyed on i18next's language, so it remounts in the new
 * language whenever that changes — including when another tree changed it, since the
 * content runtime's UIs share one i18next. A change of the configured `uiLanguage` is
 * applied in a layout effect; the selected local resource loads before the language changes, so the
 * remount paints only complete translations.
 *
 * The first value is not applied. Every entrypoint runs `initI18n` with the stored config
 * before it renders, while a jotai store that isn't hydrated starts from the default
 * config ("auto") — applying that would switch every UI sharing i18next to the browser
 * language until the stored config arrives.
 */
export function LocaleBoundary({ children }: { children: ReactNode }) {
  const uiLanguage = useAtomValue(configFieldsAtomMap.uiLanguage)
  const language = useSyncExternalStore(subscribeToLanguage, getLanguage)
  const appliedUiLanguage = useRef<typeof uiLanguage | undefined>(uiLanguage)

  useLayoutEffect(() => {
    if (appliedUiLanguage.current === uiLanguage) return
    appliedUiLanguage.current = uiLanguage
    void Promise.resolve(setUiLanguage(uiLanguage)).catch(() => {
      // Keep the last complete language on a chunk error; allow a later retry.
      appliedUiLanguage.current = undefined
    })
  }, [uiLanguage])

  return <Fragment key={language}>{children}</Fragment>
}

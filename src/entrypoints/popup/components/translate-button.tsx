import { useAtomValue } from "jotai"
import { Button } from "@/components/ui/base-ui/button"
import { Kbd, KbdGroup } from "@/components/ui/base-ui/kbd"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { featureProviderRefAtom } from "@/utils/atoms/provider"
import { i18n } from "@/utils/i18n"
import { formatHotkeyParts } from "@/utils/os.ts"
import { isShortcutEmpty } from "@/utils/shortcut"
import { cn } from "@/utils/styles/utils"
import { isIgnoreTabAtom } from "../atoms/ignore"
import { pageStatusAtom, retryPageStatusAtom, togglePageTranslationAtom } from "../atoms/session"
import { isCurrentSiteInBlacklistAtom, isCurrentSiteInWhitelistAtom } from "../atoms/site-control"

export default function TranslateButton({ className }: { className?: string }) {
  const provider = useAtomValue(featureProviderRefAtom("pageTranslation"))
  const status = useAtomValue(pageStatusAtom)
  const { run: toggleTranslation } = useAtomValue(togglePageTranslationAtom)
  const { run: retry } = useAtomValue(retryPageStatusAtom)
  const isPageTranslated = "enabled" in status && status.enabled
  const isIgnoreTab = useAtomValue(isIgnoreTabAtom)
  const translateConfig = useAtomValue(configFieldsAtomMap.pageTranslation)
  const { mode } = useAtomValue(configFieldsAtomMap.siteControl)
  const isCurrentSiteInWhitelist = useAtomValue(isCurrentSiteInWhitelistAtom)
  const isCurrentSiteInBlacklist = useAtomValue(isCurrentSiteInBlacklistAtom)

  const isSiteBlocked = mode === "whitelist" ? !isCurrentSiteInWhitelist : isCurrentSiteInBlacklist
  const isDisabled =
    status.phase !== "error" &&
    (isIgnoreTab || isSiteBlocked || status.phase !== "ready" || (!isPageTranslated && !provider))
  const shortcutParts = isShortcutEmpty(translateConfig.page.shortcut)
    ? []
    : formatHotkeyParts(translateConfig.page.shortcut)

  return (
    <Button
      data-popup-translate=""
      aria-busy={status.phase === "loading" || status.phase === "pending"}
      onClick={status.phase === "error" ? retry : toggleTranslation}
      disabled={isDisabled}
      className={cn("min-w-0", className)}
    >
      <span className="flex max-w-full min-w-0 items-center justify-center gap-2">
        <span className="min-w-0 truncate">
          {status.phase === "error"
            ? i18n.t("popup.state.retry")
            : status.phase === "loading" || status.phase === "pending"
              ? i18n.t("popup.state.loading")
              : isPageTranslated
                ? i18n.t("popup.showOriginal")
                : i18n.t("popup.translate")}
        </span>
        {status.phase === "ready" && !isPageTranslated && shortcutParts.length > 0 && (
          <KbdGroup className="shrink-0">
            {shortcutParts.map((part) => (
              <Kbd key={part} className="bg-primary-foreground/20 text-primary-foreground">
                {part}
              </Kbd>
            ))}
          </KbdGroup>
        )}
      </span>
    </Button>
  )
}

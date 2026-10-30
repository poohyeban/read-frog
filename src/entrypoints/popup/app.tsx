import { IconSettings } from "@tabler/icons-react"
import { Button } from "@/components/ui/base-ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/base-ui/tooltip"
import { i18n } from "@/utils/i18n"
import { openOptionsPage } from "@/utils/navigation"
import { version } from "../../../package.json"
import { AISmartContext } from "./components/ai-smart-context"
import { AlwaysTranslate } from "./components/always-translate"
import LanguageOptionsSelector from "./components/language-options-selector"
import Hotkey from "./components/node-translation-hotkey-selector"
import ProvidersField from "./components/providers-field"
import { SiteControlToggle } from "./components/site-control-toggle"
import TranslateButton from "./components/translate-button"
import TranslatePromptSelector from "./components/translate-prompt-selector"
import { TranslationHubButton } from "./components/translation-hub-button"
import TranslationModeSelector from "./components/translation-mode-selector"

export default function App() {
  return (
    <main className="flex flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <img src="/icon/32.png" width={24} height={24} alt="" className="shrink-0" />
          <h1 className="truncate text-sm font-semibold tracking-tight">Read Frog Lite</h1>
        </div>
        <nav className="flex shrink-0 items-center gap-0.5" aria-label="Read Frog Lite">
          <TranslationHubButton />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={i18n.t("popup.options")}
                  onClick={() => {
                    void openOptionsPage()
                  }}
                />
              }
            >
              <IconSettings aria-hidden="true" className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{i18n.t("popup.options")}</TooltipContent>
          </Tooltip>
        </nav>
      </header>
      <div className="flex flex-col gap-3 px-4 pb-3">
        <LanguageOptionsSelector />
        <div className="flex flex-col gap-2">
          <ProvidersField />
          <TranslatePromptSelector />
        </div>
        <div className="flex w-full items-center gap-2">
          <TranslationModeSelector />
          <TranslateButton className="min-w-0 flex-1" />
        </div>
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <SiteControlToggle />
          <AlwaysTranslate />
        </div>
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <Hotkey />
          <AISmartContext />
        </div>
      </div>
      <footer className="px-4 pb-2 text-right text-xs text-muted-foreground">v{version}</footer>
    </main>
  )
}

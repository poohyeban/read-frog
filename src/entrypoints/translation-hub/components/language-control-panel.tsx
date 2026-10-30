import { Icon } from "@iconify/react/offline"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { useEffect } from "react"
import { Button } from "@/components/ui/base-ui/button"
import { i18n } from "@/utils/i18n"
import {
  detectedLangCodeAtom,
  detectedSourceLangCodeAtom,
  exchangeLangCodesAtom,
  inputTextAtom,
  sourceLangCodeAtom,
  targetLangCodeAtom,
} from "../atoms"
import { SearchableLanguageSelector } from "./searchable-language-selector"

export function LanguageControlPanel() {
  const [sourceLangCode, setSourceLangCode] = useAtom(sourceLangCodeAtom)
  const [targetLangCode, setTargetLangCode] = useAtom(targetLangCodeAtom)
  const exchangeLangCodes = useSetAtom(exchangeLangCodesAtom)
  const inputText = useAtomValue(inputTextAtom)
  const setDetectedSourceLangCode = useSetAtom(detectedSourceLangCodeAtom)
  const detectedLangCode = useAtomValue(detectedLangCodeAtom)

  useEffect(() => {
    let active = true
    if (sourceLangCode !== "auto" || !inputText.trim()) {
      setDetectedSourceLangCode(null)
      return undefined
    }
    const timer = setTimeout(() => {
      void import("@/utils/content/language")
        .then(async ({ detectLanguage }) => {
          if (!active) return
          const detected = await detectLanguage(inputText, { minLength: 1 })
          if (active) setDetectedSourceLangCode(detected)
        })
        .catch(() => {
          if (active) setDetectedSourceLangCode(null)
        })
    }, 1000)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [inputText, sourceLangCode, setDetectedSourceLangCode])

  return (
    <div className="flex w-full items-center gap-3">
      <SearchableLanguageSelector
        className="min-w-0 flex-1"
        value={sourceLangCode}
        onValueChange={setSourceLangCode}
        detectedLangCode={detectedLangCode}
        label={i18n.t("side.sourceLang")}
      />

      <div className="shrink-0 self-end pb-0.5">
        <Button
          variant="ghost"
          size="icon"
          onClick={exchangeLangCodes}
          title={i18n.t("translationHub.exchangeLanguages")}
        >
          <Icon icon="tabler:arrows-exchange" className="h-4 w-4" />
        </Button>
      </div>

      <SearchableLanguageSelector
        className="min-w-0 flex-1"
        value={targetLangCode}
        onValueChange={(value) => {
          if (value !== "auto") void setTargetLangCode(value)
        }}
        label={i18n.t("side.targetLang")}
      />
    </div>
  )
}

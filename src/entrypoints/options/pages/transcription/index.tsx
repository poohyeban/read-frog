import { useAtom } from "jotai"
import { Input } from "@/components/ui/base-ui/input"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
import { AudioServiceSection } from "../../components/audio-service-section"
import { ConfigItem } from "../../components/config-item"
import { PageLayout } from "../../components/page-layout"

export function TranscriptionPage() {
  const [config, setConfig] = useAtom(configFieldsAtomMap.transcription)
  return (
    <PageLayout
      title={i18n.t("audioServices.transcription")}
      description={i18n.t("audioServices.transcriptionDescription")}
      innerClassName="flex flex-col gap-8"
    >
      <AudioServiceSection capability="transcription" />
      <ConfigItem
        title={i18n.t("audioServices.language")}
        description={i18n.t("audioServices.languageDescription")}
      >
        <Input
          value={config.language}
          aria-label={i18n.t("audioServices.language")}
          onChange={(e) => void setConfig({ language: e.target.value })}
        />
      </ConfigItem>
      <ConfigItem title={i18n.t("audioServices.responseFormat")}>
        <select
          aria-label={i18n.t("audioServices.responseFormat")}
          value={config.responseFormat}
          onChange={(e) =>
            void setConfig({ responseFormat: e.target.value === "json" ? "json" : "verbose_json" })
          }
        >
          <option value="verbose_json">verbose_json</option>
          <option value="json">json</option>
        </select>
      </ConfigItem>
    </PageLayout>
  )
}

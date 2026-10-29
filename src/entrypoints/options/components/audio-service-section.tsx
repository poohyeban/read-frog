import { useAtomValue, useSetAtom } from "jotai"
import ProviderSelector from "@/components/llm-providers/provider-selector"
import { useFeatureProvider } from "@/components/llm-providers/use-feature-providers"
import { Button } from "@/components/ui/base-ui/button"
import { Input } from "@/components/ui/base-ui/input"
import { configAtom, writeConfigAtom } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
import { ConfigItem } from "./config-item"
import { ConfigSection } from "./config-section"

export function AudioServiceSection({ capability }: { capability: "tts" | "transcription" }) {
  const config = useAtomValue(configAtom)
  const setConfig = useSetAtom(writeConfigAtom)
  const settings = config[capability]
  const { providers, providerId, providerConfig, setProviderId } = useFeatureProvider(capability)
  return (
    <ConfigSection id="audio-service" title={i18n.t("audioServices.service")}>
      <p role="status" className="text-sm text-muted-foreground">
        {providerConfig?.enabled && settings.model
          ? i18n.t("audioServices.selected")
          : i18n.t("audioServices.notConfigured")}
      </p>
      <ConfigItem
        title={i18n.t("audioServices.provider")}
        description={i18n.t("audioServices.providerDescription")}
      >
        <div className="flex items-center gap-2">
          <ProviderSelector
            providers={providers}
            value={providerId}
            onChange={setProviderId}
            placeholder={i18n.t("audioServices.notConfigured")}
          />
          {providerId && (
            <Button variant="ghost" size="sm" onClick={() => setProviderId("")}>
              {i18n.t("audioServices.clear")}
            </Button>
          )}
        </div>
      </ConfigItem>
      <ConfigItem
        title={i18n.t("audioServices.model")}
        description={i18n.t("audioServices.modelDescription")}
      >
        <Input
          aria-label={i18n.t("audioServices.model")}
          value={settings.model}
          onChange={(e) => void setConfig({ [capability]: { ...settings, model: e.target.value } })}
        />
      </ConfigItem>
      <ConfigItem title={i18n.t("audioServices.timeout")}>
        <Input
          key={settings.timeoutMs}
          aria-label={i18n.t("audioServices.timeout")}
          type="number"
          min={1000}
          max={600000}
          defaultValue={settings.timeoutMs}
          onBlur={(e) => {
            const value = Number(e.target.value)
            if (Number.isInteger(value) && value >= 1000 && value <= 600000)
              void setConfig({ [capability]: { ...settings, timeoutMs: value } })
            else e.target.value = String(settings.timeoutMs)
          }}
        />
      </ConfigItem>
      {capability === "tts" && (
        <ConfigItem title={i18n.t("audioServices.outputFormat")}>
          <select
            aria-label={i18n.t("audioServices.outputFormat")}
            value={config.tts.outputFormat}
            onChange={(e) =>
              void setConfig({
                tts: { ...config.tts, outputFormat: e.target.value === "wav" ? "wav" : "mp3" },
              })
            }
          >
            <option value="mp3">MP3</option>
            <option value="wav">WAV</option>
          </select>
        </ConfigItem>
      )}
    </ConfigSection>
  )
}

import { i18n } from "@/utils/i18n"
import { ConfigSection } from "../../../components/config-section"
import { ResetConfigItem } from "./reset-config"
export function ConfigManagementSection() {
  return (
    <ConfigSection title={i18n.t("options.preference.config.title")}>
      <ResetConfigItem />
    </ConfigSection>
  )
}

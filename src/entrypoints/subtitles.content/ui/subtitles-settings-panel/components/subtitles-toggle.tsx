import { IconSubtitles } from "@tabler/icons-react"
import { useAtomValue } from "jotai"
import { Switch } from "@/components/ui/base-ui/switch"
import { APP_NAME } from "@/utils/constants/app"
import { i18n } from "@/utils/i18n"
import { subtitlesVisibleAtom, subtitleStopPhaseAtom } from "../../../atoms"
import { useSubtitlesUI } from "../../subtitles-ui-context"
import { SubtitlesSettingsItem } from "./subtitles-settings-item"

export function SubtitlesToggle() {
  const title = `${APP_NAME} ${i18n.t("options.videoSubtitles.title")}`
  const switchId = "read-frog-subtitles-toggle"

  const stopPhase = useAtomValue(subtitleStopPhaseAtom)
  const isVisible = useAtomValue(subtitlesVisibleAtom)
  const { toggleSubtitles } = useSubtitlesUI()

  return (
    <SubtitlesSettingsItem
      icon={<IconSubtitles className="size-3.5" />}
      label={
        stopPhase === "stopping"
          ? i18n.t("subtitles.work.stopping")
          : stopPhase === "failed"
            ? i18n.t("subtitles.work.stopFailed")
            : title
      }
      labelFor={switchId}
    >
      <Switch
        id={switchId}
        checked={isVisible}
        onCheckedChange={(checked) => toggleSubtitles(checked)}
        aria-label={title}
      />
    </SubtitlesSettingsItem>
  )
}

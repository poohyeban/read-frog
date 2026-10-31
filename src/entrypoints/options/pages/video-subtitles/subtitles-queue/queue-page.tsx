import { useAtomValue } from "jotai"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
import { ConfigDetailSection } from "../../../components/config-detail-section"
import { PageLayout } from "../../../components/page-layout"
import { PerformanceSettings } from "../../../components/performance-settings"

/**
 * Drilled into from the Video Subtitles page: how fast subtitle requests go out and how many
 * lines each carries. They tune latency and bounded request load.
 */
export function SubtitlesQueuePage() {
  const config = useAtomValue(configFieldsAtomMap.videoSubtitles)
  return (
    <PageLayout
      title={i18n.t("options.videoSubtitles.title")}
      description={i18n.t("options.videoSubtitles.pageDescription")}
    >
      <ConfigDetailSection
        backTo="/video-subtitles"
        title={
          <span id="subtitles-queue">{i18n.t("options.videoSubtitles.subtitlesQueue.title")}</span>
        }
      >
        <PerformanceSettings feature="subtitles" providerId={config.providerId} />
      </ConfigDetailSection>
    </PageLayout>
  )
}

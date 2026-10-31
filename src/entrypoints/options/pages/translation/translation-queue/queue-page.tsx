import { useAtomValue } from "jotai"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
import { ConfigDetailSection } from "../../../components/config-detail-section"
import { PageLayout } from "../../../components/page-layout"
import { PerformanceSettings } from "../../../components/performance-settings"
import { PreloadItems } from "./preload-items"

/**
 * Drilled into from the Translation page: how fast requests go out, how much text each carries,
 * and how far ahead of the reader they run. These controls tune latency and bounded request load.
 */
export function TranslationQueuePage() {
  const config = useAtomValue(configFieldsAtomMap.pageTranslation)
  return (
    <PageLayout
      title={i18n.t("options.translation.title")}
      description={i18n.t("options.translation.pageDescription")}
    >
      <ConfigDetailSection
        backTo="/page-translation"
        title={
          <span id="translation-queue">{i18n.t("options.translation.translationQueue.title")}</span>
        }
      >
        <PerformanceSettings feature="page" providerId={config.providerId} />
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {i18n.t("options.translation.translationQueue.preloadConfig.title")}
          </summary>
          <PreloadItems />
        </details>
      </ConfigDetailSection>
    </PageLayout>
  )
}

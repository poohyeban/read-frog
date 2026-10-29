import { i18n } from "@/utils/i18n"
import { AudioServiceSection } from "../../components/audio-service-section"
import { PageLayout } from "../../components/page-layout"
import { SpeechSection } from "./speech"
import { VoiceSection } from "./voice"

export function TextToSpeechPage() {
  return (
    <PageLayout
      title={i18n.t("options.tts.title")}
      description={i18n.t("options.tts.pageDescription")}
      innerClassName="flex flex-col gap-10"
    >
      <AudioServiceSection capability="tts" />
      <VoiceSection />
      <SpeechSection />
    </PageLayout>
  )
}

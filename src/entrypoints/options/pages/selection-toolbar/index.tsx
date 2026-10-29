import { i18n } from "@/utils/i18n"
import { PageLayout } from "../../components/page-layout"
import { ActionsSection } from "./actions"
import { DisplaySection } from "./display"
import { EnableItem } from "./enable-item"

export function SelectionToolbarPage() {
  return (
    <PageLayout
      title={i18n.t("options.selectionToolbar.title")}
      description={i18n.t("options.selectionToolbar.pageDescription")}
      innerClassName="flex flex-col gap-10"
    >
      <EnableItem />
      <ActionsSection />
      <DisplaySection />
    </PageLayout>
  )
}

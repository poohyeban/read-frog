import { saveAs } from "file-saver"
import { useAtom } from "jotai"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/base-ui/button"
import { Input } from "@/components/ui/base-ui/input"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { DEFAULT_SUBTITLE_BUDGET } from "@/utils/subtitles/work-policy"
import { ConfigItem } from "../../../components/config-item"

export function SubtitleWorkBudgetItems() {
  const [config, setConfig] = useAtom(configFieldsAtomMap.videoSubtitles)
  const budget = config.workBudget ?? DEFAULT_SUBTITLE_BUDGET
  const [status, setStatus] = useState<Awaited<
    ReturnType<typeof sendMessage<"getSubtitleBudgetStatus">>
  > | null>(null)
  useEffect(() => {
    let current = true
    void sendMessage("getSubtitleBudgetStatus", undefined)
      .then((value) => {
        if (current) setStatus(value)
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [])
  return (
    <>
      <ConfigItem
        title={i18n.t("subtitles.work.title")}
        description={i18n.t("subtitles.work.description")}
      >
        {null}
      </ConfigItem>
      {(["requests", "estimatedTokens", "maxInFlight"] as const).map((property) => (
        <ConfigItem
          key={property}
          title={i18n.t(
            property === "requests"
              ? "subtitles.work.requests"
              : property === "estimatedTokens"
                ? "subtitles.work.tokens"
                : "subtitles.work.concurrency",
          )}
        >
          <Input
            className="w-36"
            type="number"
            min={property === "maxInFlight" ? 1 : 0}
            max={
              property === "maxInFlight" ? 4 : property === "requests" ? 1_000_000 : 1_000_000_000
            }
            value={budget[property]}
            onChange={(event) => {
              const value = Number(event.target.value)
              const maximum =
                property === "maxInFlight" ? 4 : property === "requests" ? 1_000_000 : 1_000_000_000
              if (
                event.target.value &&
                Number.isSafeInteger(value) &&
                value >= (property === "maxInFlight" ? 1 : 0) &&
                value <= maximum
              )
                void setConfig({ workBudget: { ...budget, [property]: value } })
            }}
          />
        </ConfigItem>
      ))}
      <ConfigItem title={i18n.t("subtitles.work.diagnostics")}>
        <Input
          type="checkbox"
          className="size-4"
          checked={budget.diagnostics}
          onChange={(event) => {
            void setConfig({ workBudget: { ...budget, diagnostics: event.target.checked } })
          }}
        />
      </ConfigItem>
      {status && (
        <p className="text-sm text-muted-foreground">
          {i18n.t("subtitles.work.status", [
            String(status.ledger.requests),
            String(status.ledger.estimatedTokens),
            status.ledger.usageReports
              ? String(status.ledger.actualInputTokens + status.ledger.actualOutputTokens)
              : "—",
          ])}
        </p>
      )}
      <Button
        variant="outline"
        onClick={async () => {
          const data = await sendMessage("getSubtitleBudgetStatus", undefined)
          setStatus(data)
          saveAs(
            new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
            "subtitle-diagnostics.json",
          )
        }}
      >
        {i18n.t("subtitles.work.exportDiagnostics")}
      </Button>
    </>
  )
}

import { saveAs } from "file-saver"
import { useAtomValue } from "jotai"
import { useEffect, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/base-ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/base-ui/collapsible"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import {
  getPerformanceOverrides,
  initializePerformance,
  watchPerformance,
} from "@/utils/config/performance"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { BATCH_DEFAULTS } from "@/utils/request/performance-config"
import {
  GLOBAL_RESOURCE_DEFAULTS,
  RESOURCE_DEFAULTS,
  SUBTITLE_PERFORMANCE_DEFAULTS,
} from "@/utils/request/resource-policy"
import { PerformanceFields } from "./fields"
import { PerformanceGroups } from "./groups"

export function PerformanceSettings({
  feature,
  providerId,
}: {
  feature?: "page" | "subtitles"
  providerId?: string
}) {
  const providers = useAtomValue(configFieldsAtomMap.providersConfig)
  const overrides = useSyncExternalStore(
    watchPerformance,
    getPerformanceOverrides,
    getPerformanceOverrides,
  )
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(providerId ?? providers[0]?.id ?? "")
  const [identities, setIdentities] = useState<Record<string, string>>({})
  const [error, setError] = useState("")
  useEffect(() => {
    // Provider edits invalidate the background identity snapshot.
    if (!providers.length) return undefined
    let active = true
    void initializePerformance()
      .then(() => sendMessage("getPerformanceConfiguration"))
      .then(
        (result) => {
          if (active) {
            setIdentities(result.identities)
            setError("")
          }
        },
        () => {
          if (active) setError(i18n.t("options.performance.unavailable"))
        },
      )
    return () => {
      active = false
    }
  }, [providers])
  const physical = identities[selected]
  const group = physical
    ? Object.values(overrides.groups ?? {}).find((candidate) =>
        candidate.members.includes(physical),
      )
    : undefined
  const defaults = { ...RESOURCE_DEFAULTS, ...group?.policy }
  const currentProvider = providers.find((provider) => provider.id === selected)
  return (
    <Collapsible id="performance-settings" open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger className="text-sm font-medium underline underline-offset-4">
        {i18n.t("options.performance.advanced")}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-6 pt-4">
        <p className="text-sm text-muted-foreground">{i18n.t("options.performance.description")}</p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {feature === "subtitles" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void sendMessage("getSubtitleDiagnostics").then(
                (diagnostics) => {
                  saveAs(
                    new Blob([JSON.stringify(diagnostics, null, 2)], { type: "application/json" }),
                    "read-frog-subtitle-diagnostics.json",
                  )
                },
                () => setError(i18n.t("options.performance.unavailable")),
              )
            }}
          >
            {i18n.t("options.performance.exportDiagnostics")}
          </Button>
        )}
        {feature && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              {i18n.t("options.performance.batches")}
            </summary>
            <div className="pt-4">
              <PerformanceFields
                target={{ section: "batch", id: feature }}
                defaults={BATCH_DEFAULTS}
                overrides={overrides.batches?.[feature]}
              />
            </div>
          </details>
        )}
        {feature === "subtitles" && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              {i18n.t("options.performance.buffers")}
            </summary>
            <div className="pt-4">
              <PerformanceFields
                target={{ section: "subtitles" }}
                defaults={SUBTITLE_PERFORMANCE_DEFAULTS}
                overrides={overrides.subtitles}
              />
            </div>
          </details>
        )}
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {i18n.t("options.performance.provider")}
          </summary>
          <div className="space-y-4 pt-4">
            <select
              aria-label={i18n.t("options.performance.provider")}
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              className="w-full rounded-md border bg-background p-2 text-sm"
            >
              {providers.map((provider) => (
                <option value={provider.id} key={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
            {currentProvider && (
              <PerformanceFields
                key={selected}
                target={{ section: "provider", id: selected }}
                defaults={defaults}
                overrides={overrides.providers?.[selected]}
              />
            )}
          </div>
        </details>
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {i18n.t("options.performance.groups")}
          </summary>
          <div className="pt-4">
            <PerformanceGroups
              providers={providers}
              identities={identities}
              groups={overrides.groups}
            />
          </div>
        </details>
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {i18n.t("options.performance.global")}
          </summary>
          <div className="pt-4">
            <PerformanceFields
              target={{ section: "global" }}
              defaults={GLOBAL_RESOURCE_DEFAULTS}
              overrides={overrides.global}
            />
          </div>
        </details>
      </CollapsibleContent>
    </Collapsible>
  )
}

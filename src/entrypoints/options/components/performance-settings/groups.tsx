import type { ProvidersConfig } from "@/types/config/provider"
import type { PerformanceOverrides } from "@/utils/request/performance-config"
import { useState } from "react"
import { Button } from "@/components/ui/base-ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/base-ui/collapsible"
import { Input } from "@/components/ui/base-ui/input"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { RESOURCE_DEFAULTS } from "@/utils/request/resource-policy"
import { PerformanceFields } from "./fields"

const EMPTY_GROUPS = Object.freeze({})

export function PerformanceGroups({
  providers,
  identities,
  groups = EMPTY_GROUPS,
}: {
  providers: ProvidersConfig
  identities: Record<string, string>
  groups?: PerformanceOverrides["groups"]
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [members, setMembers] = useState<string[]>([])
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const resources = new Map<string, string[]>()
  for (const provider of providers) {
    const resource = identities[provider.id]
    if (!resource) continue
    resources.set(resource, [...(resources.get(resource) ?? []), provider.name])
  }
  function edit(id: string) {
    setEditing(id)
    setName(groups[id]?.name ?? "")
    setMembers((groups[id]?.members ?? []).filter((member) => resources.has(member)))
    setError("")
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {i18n.t("options.performance.groupDescription")}
      </p>
      {Object.entries(groups).map(([id, group]) => (
        <Collapsible key={id}>
          <CollapsibleTrigger className="text-sm font-medium underline underline-offset-4">
            {group.name}
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-4">
            <p className="text-sm text-muted-foreground">
              {group.members
                .map((member) => resources.get(member)?.join(" / "))
                .filter(Boolean)
                .join(", ") || i18n.t("options.performance.unavailable")}
            </p>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => edit(id)}>
                {i18n.t("options.performance.editGroup")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void sendMessage("patchPerformanceConfiguration", {
                    kind: "delete-group",
                    id,
                  }).catch(() => setError(i18n.t("options.performance.invalid")))
                }}
              >
                {i18n.t("options.performance.deleteGroup")}
              </Button>
            </div>
            <PerformanceFields
              target={{ section: "group", id }}
              defaults={RESOURCE_DEFAULTS}
              overrides={group.policy}
            />
          </CollapsibleContent>
        </Collapsible>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={() => edit("new")}>
        {i18n.t("options.performance.createGroup")}
      </Button>
      {editing !== null && (
        <div className="space-y-3 rounded-md border p-4">
          <Input
            aria-label={i18n.t("options.performance.groupName")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault()
            }}
          />
          {[...resources].map(([resource, names]) => {
            const assignedElsewhere = Object.entries(groups).some(
              ([id, group]) => id !== editing && group.members.includes(resource),
            )
            return (
              <label key={resource} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={assignedElsewhere || saving}
                  checked={members.includes(resource)}
                  onChange={(event) =>
                    setMembers((current) =>
                      event.target.checked
                        ? [...current, resource]
                        : current.filter((member) => member !== resource),
                    )
                  }
                />
                <span>
                  {names.join(" / ")}
                  {assignedElsewhere && ` · ${i18n.t("options.performance.alreadyGrouped")}`}
                </span>
              </label>
            )
          })}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={saving || !name.trim() || !members.length}
              onClick={() => {
                setSaving(true)
                void sendMessage("patchPerformanceConfiguration", {
                  kind: editing === "new" ? "create-group" : "edit-group",
                  id: editing === "new" ? getRandomUUID() : editing,
                  name,
                  members,
                })
                  .then(
                    () => setEditing(null),
                    () => setError(i18n.t("options.performance.invalid")),
                  )
                  .finally(() => setSaving(false))
              }}
            >
              {i18n.t("options.performance.save")}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(null)}>
              {i18n.t("options.performance.cancel")}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

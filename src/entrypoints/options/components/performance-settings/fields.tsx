import type { PerformanceTarget } from "@/utils/request/performance-patch"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/base-ui/button"
import { Input } from "@/components/ui/base-ui/input"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { ConfigItem } from "../config-item"

const EMPTY_OVERRIDES = Object.freeze({})

const labels = {
  rate: () => i18n.t("options.performance.fields.rate"),
  capacity: () => i18n.t("options.performance.fields.capacity"),
  maxInFlight: () => i18n.t("options.performance.fields.maxInFlight"),
  maxQueued: () => i18n.t("options.performance.fields.maxQueued"),
  timeoutMs: () => i18n.t("options.performance.fields.timeoutMs"),
  maxAttempts: () => i18n.t("options.performance.fields.maxAttempts"),
  baseRetryDelayMs: () => i18n.t("options.performance.fields.baseRetryDelayMs"),
  maxRetryDelayMs: () => i18n.t("options.performance.fields.maxRetryDelayMs"),
  cooldownMs: () => i18n.t("options.performance.fields.cooldownMs"),
  priorityAgingMs: () => i18n.t("options.performance.fields.priorityAgingMs"),
  maxItemsPerBatch: () => i18n.t("options.performance.fields.maxItemsPerBatch"),
  maxCharactersPerBatch: () => i18n.t("options.performance.fields.maxCharactersPerBatch"),
  batchDelay: () => i18n.t("options.performance.fields.batchDelay"),
  maxPending: () => i18n.t("options.performance.fields.maxPending"),
  diagnostics: () => i18n.t("options.performance.fields.diagnostics"),
  maxPendingBatches: () => i18n.t("options.performance.fields.maxPendingBatches"),
  batchSize: () => i18n.t("options.performance.fields.batchSize"),
  cacheRestoreTimeoutMs: () => i18n.t("options.performance.fields.cacheRestoreTimeoutMs"),
  cacheRestoreRetryMs: () => i18n.t("options.performance.fields.cacheRestoreRetryMs"),
  fastAheadMs: () => i18n.t("options.performance.fields.fastAheadMs"),
  qualityAheadMs: () => i18n.t("options.performance.fields.qualityAheadMs"),
  lowMinMs: () => i18n.t("options.performance.fields.lowMinMs"),
  lowMaxMs: () => i18n.t("options.performance.fields.lowMaxMs"),
  highMinMs: () => i18n.t("options.performance.fields.highMinMs"),
  highMaxMs: () => i18n.t("options.performance.fields.highMaxMs"),
}

export function PerformanceNumberInput({
  label,
  value,
  step = 1,
  save,
}: {
  label: string
  value: number
  step?: number
  save: (value: number) => Promise<unknown>
}) {
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(String(value))
  }, [value])
  async function commit() {
    focused.current = false
    if (draft === String(value)) return
    const number = Number(draft)
    if (!draft.trim() || !Number.isFinite(number)) {
      setError(i18n.t("options.performance.invalid"))
      return
    }
    setSaving(true)
    try {
      await save(number)
      setError("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : i18n.t("options.performance.invalid"))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="flex max-w-64 flex-col items-end gap-1">
      <Input
        type="number"
        step={step}
        aria-label={label}
        aria-invalid={!!error}
        disabled={saving}
        value={draft}
        className="w-32"
        onFocus={() => {
          focused.current = true
        }}
        onChange={(event) => {
          setDraft(event.target.value)
          setError("")
        }}
        onBlur={() => {
          void commit()
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            event.currentTarget.blur()
          }
          if (event.key === "Escape") {
            setDraft(String(value))
            setError("")
          }
        }}
      />
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  )
}

export function PerformanceFields({
  target,
  defaults,
  overrides = EMPTY_OVERRIDES,
}: {
  target: PerformanceTarget
  defaults: Record<string, number | boolean>
  overrides?: Record<string, number | boolean>
}) {
  const [error, setError] = useState("")
  const save = (field: string, value: number | boolean) =>
    sendMessage("patchPerformanceConfiguration", { kind: "set", target, field, value })
  return (
    <div className="space-y-4">
      {Object.entries(defaults).map(([field, fallback]) => {
        const label = labels[field as keyof typeof labels]()
        const value = overrides[field] ?? fallback
        return (
          <ConfigItem
            key={field}
            title={label}
            description={
              <span>
                {i18n.t("options.performance.defaultValue", [String(fallback)])}
                {overrides[field] !== undefined && ` · ${i18n.t("options.performance.custom")}`}
              </span>
            }
          >
            {typeof value === "boolean" ? (
              <input
                type="checkbox"
                aria-label={label}
                checked={value}
                onChange={(event) => {
                  void save(field, event.target.checked).catch(() =>
                    setError(i18n.t("options.performance.invalid")),
                  )
                }}
              />
            ) : (
              <PerformanceNumberInput
                label={label}
                value={value}
                step={field === "rate" ? 0.01 : 1}
                save={(nextValue) => save(field, nextValue)}
              />
            )}
          </ConfigItem>
        )
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void sendMessage("patchPerformanceConfiguration", { kind: "reset", target }).then(
            () => setError(""),
            () => setError(i18n.t("options.performance.invalid")),
          )
        }}
      >
        {i18n.t("options.performance.reset")}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

import { useState } from "react"
import { Input } from "@/components/ui/base-ui/input"

// User services define their own voice IDs; the upstream Edge catalogue is not applicable.
export function TTSVoiceCombobox({
  value,
  onValueChange,
  className,
  "aria-label": label,
}: {
  value: string
  onValueChange: (value: string) => void
  className?: string
  "aria-label"?: string
}) {
  const [draft, setDraft] = useState(value)
  const [previous, setPrevious] = useState(value)
  if (previous !== value) {
    setPrevious(value)
    setDraft(value)
  }
  return (
    <Input
      className={className}
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onValueChange(draft.trim())}
    />
  )
}

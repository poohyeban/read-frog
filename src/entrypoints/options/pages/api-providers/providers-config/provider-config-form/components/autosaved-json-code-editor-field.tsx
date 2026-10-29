import type { ReactNode } from "react"
import { dequal } from "dequal"
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useAutosaveContext } from "@/components/form/use-autosave"
import { Field, FieldError, FieldTitle } from "@/components/ui/base-ui/field"
import { Skeleton } from "@/components/ui/base-ui/skeleton"

const JSONCodeEditor = lazy(() =>
  import("@/components/ui/json-code-editor").then((module) => ({ default: module.JSONCodeEditor })),
)

export type JsonEditorParseResult<TValue> =
  | { valid: true; value: TValue | undefined }
  | { valid: false; error: string }

interface AutosavedJsonCodeEditorFieldProps<TValue extends Record<string, unknown>> {
  value: TValue | undefined
  label: ReactNode
  placeholder: string
  editorAriaLabel: string
  fieldName: string
  parse: (input: string) => JsonEditorParseResult<TValue>
  onCommit: (value: TValue | undefined) => void
  serialize?: (value: TValue | undefined) => string
  height?: string
}

function defaultSerializeJson(value: Record<string, unknown> | undefined) {
  return value ? JSON.stringify(value, null, 2) : ""
}

export function AutosavedJsonCodeEditorField<TValue extends Record<string, unknown>>({
  value,
  label,
  placeholder,
  editorAriaLabel,
  fieldName,
  parse,
  onCommit,
  serialize = defaultSerializeJson,
  height = "150px",
}: AutosavedJsonCodeEditorFieldProps<TValue>) {
  const autosave = useAutosaveContext()
  const [jsonInput, setJsonInput] = useState(() => serialize(value))
  const [jsonError, setJsonError] = useState<string | null>(null)
  const textRef = useRef(jsonInput)
  const savedTextRef = useRef(jsonInput)
  const latest = useRef({ value, parse, onCommit, serialize })
  useLayoutEffect(() => {
    latest.current = { value, parse, onCommit, serialize }
  })

  useLayoutEffect(
    () =>
      autosave.registerSource(fieldName, {
        isDirty: () => textRef.current !== savedTextRef.current,
        snapshot: () => textRef.current,
        prepare: () => {
          const result = latest.current.parse(textRef.current)
          setJsonError(result.valid ? null : result.error)
          if (!result.valid) return false
          if (!dequal(result.value, latest.current.value)) latest.current.onCommit(result.value)
          return true
        },
        acknowledge: (snapshot) => {
          savedTextRef.current = snapshot
        },
        reset: (nextValue) => {
          const text = latest.current.serialize(nextValue as TValue | undefined)
          textRef.current = savedTextRef.current = text
          setJsonInput(text)
          setJsonError(null)
        },
      }),
    [autosave, fieldName],
  )

  useEffect(() => {
    const current = parse(textRef.current)
    // Keep formatting after our own commit. Only pristine raw drafts accept external values.
    if (current.valid && dequal(current.value, value)) return
    if (textRef.current !== savedTextRef.current) return
    const text = serialize(value)
    textRef.current = savedTextRef.current = text
    setJsonInput(text)
    setJsonError(null)
  }, [value, parse, serialize])

  const updateText = useCallback(
    (text: string) => {
      autosave.edit(() => {
        textRef.current = text
        setJsonInput(text)
        setJsonError(null)
      })
    },
    [autosave],
  )
  const flush = useCallback(() => {
    void autosave.flush()
  }, [autosave])
  return (
    <Field data-invalid={!!jsonError}>
      <FieldTitle>{label}</FieldTitle>
      <div
        onCompositionStartCapture={() => autosave.beginComposition(fieldName)}
        onCompositionEndCapture={() => autosave.endComposition(fieldName, () => {})}
      >
        <Suspense fallback={<Skeleton style={{ height }} aria-hidden="true" />}>
          <JSONCodeEditor
            aria-label={editorAriaLabel}
            value={jsonInput}
            onChange={updateText}
            onBlur={flush}
            placeholder={placeholder}
            hasError={!!jsonError}
            height={height}
          />
        </Suspense>
      </div>
      {jsonError && <FieldError>{jsonError}</FieldError>}
    </Field>
  )
}

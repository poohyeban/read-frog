import type { ReactCodeMirrorProps } from "@uiw/react-codemirror"
import { lazy, Suspense } from "react"
import { i18n } from "@/utils/i18n"

interface JSONCodeEditorProps extends Omit<ReactCodeMirrorProps, "theme" | "extensions"> {
  hasError?: boolean
}
const loadEditor = () =>
  import("./json-code-editor-impl").then((module) => ({ default: module.JSONCodeEditor }))
const Editor = lazy(loadEditor)
export function preloadJSONCodeEditor() {
  void loadEditor().catch(() => {})
}

/** Only mount CodeMirror when a field is visible; keep its owning draft mounted afterwards. */
export function JSONCodeEditor(props: JSONCodeEditorProps) {
  return (
    <Suspense
      fallback={
        <div
          role="status"
          aria-busy="true"
          className="rounded-lg border p-3 text-muted-foreground"
          style={{ minHeight: props.height ?? "150px" }}
        >
          {i18n.t("ui.loading")}
        </div>
      }
    >
      <Editor {...props} />
    </Suspense>
  )
}

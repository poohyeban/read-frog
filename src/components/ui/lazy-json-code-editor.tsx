import type { JSONCodeEditorProps } from "./json-code-editor"
import { lazy, Suspense } from "react"
import { Skeleton } from "./base-ui/skeleton"

const Editor = lazy(() =>
  import("./json-code-editor").then((module) => ({ default: module.JSONCodeEditor })),
)

export function LazyJSONCodeEditor(props: JSONCodeEditorProps) {
  return (
    <Suspense fallback={<Skeleton style={{ height: props.height }} aria-hidden="true" />}>
      <Editor {...props} />
    </Suspense>
  )
}

import { attachRequestErrorMeta } from "@/utils/request/retry-policy"

export class ModelOutputValidationError extends Error {}

/** A length finish is not evidence that another paid call will fit the same budget. */
export function outputLimitError(message: string): Error {
  return attachRequestErrorMeta(new ModelOutputValidationError(message), { isRetryable: false })
}

/** Preserve providers that emit a closing-only think tag, but never leak an unclosed thought. */
export function visibleModelText(text: string): string {
  const open = [...text.matchAll(/<think\s*>/gi)].at(-1)
  const close = [...text.matchAll(/<\/think\s*>/gi)].at(-1)
  if (open && (!close || open.index > close.index))
    throw outputLimitError("Incomplete model reasoning output")
  return close ? text.slice(close.index + close[0].length) : text
}

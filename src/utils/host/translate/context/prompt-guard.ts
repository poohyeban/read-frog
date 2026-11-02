import { ContextStaleError } from "./snapshot-manager"

// Weak capabilities follow the context data through local prompt construction.
// They are never serialized, included in a cache identity or used by a render gate.
const validations = new WeakMap<object, { validate: () => boolean }>()
export function registerPromptContext(context: object, validate: () => boolean): void {
  const record = validations.get(context)
  if (record) record.validate = validate
  else validations.set(context, { validate })
}
export function inheritPromptContext<T extends object>(
  source: object | null | undefined,
  target: T,
): T {
  const validate = source && validations.get(source)
  if (validate) validations.set(target, validate)
  return target
}
/** Only at a new model dispatch, after async preparation. Never after a response. */
export function isPromptContextCurrent(context: object | null | undefined): boolean {
  return !context || validations.get(context)?.validate() !== false
}
export function assertPromptContextCurrent(context: object | null | undefined): void {
  if (!isPromptContextCurrent(context)) throw new ContextStaleError()
}

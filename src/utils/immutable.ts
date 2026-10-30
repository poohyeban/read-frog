/** Freeze a plain-data snapshot after cloning at the request boundary. */
export function freezeData<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeData(child)
    Object.freeze(value)
  }
  return value
}

import type { ZodSchema } from "zod"
import { storage } from "#imports"
import { isExtensionContextInvalidatedError } from "@/utils/error/extension-context"
import { isNonNullish } from "@/utils/utils"

export const storageAdapter = {
  async get<T>(key: string, fallback: T, schema: ZodSchema<T>): Promise<T> {
    const value = await storage.getItem<T>(`local:${key}`)
    if (isNonNullish(value)) {
      const parsedValue = schema.safeParse(value)
      if (parsedValue.success) {
        return parsedValue.data
      }
    }
    return fallback
  },
  async set<T>(key: string, value: T, schema: ZodSchema<T>) {
    const parsedValue = schema.safeParse(value)
    if (parsedValue.success) {
      await storage.setItem(`local:${key}`, parsedValue.data)
    } else {
      throw new Error(parsedValue.error.message)
    }
  },
  async setMeta(key: string, meta: Record<string, unknown>) {
    await storage.setMeta(`local:${key}`, meta)
  },
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T preserves caller callback typing for typed storage values.
  watch<T>(key: string, callback: (newValue: T) => void) {
    const unwatch = storage.watch<T>(`local:${key}`, (newValue) => {
      if (isNonNullish(newValue)) callback(newValue)
    })
    return () => {
      try {
        unwatch()
      } catch (error) {
        // Chrome already discarded its listeners when the extension reloaded.
        // WXT resolves storage again during unwatch, which can now throw and
        // interrupt React/Jotai cleanup before DOM listeners are removed.
        if (!isExtensionContextInvalidatedError(error)) throw error
      }
    }
  },
}

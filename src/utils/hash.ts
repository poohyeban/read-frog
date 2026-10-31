import { sha256 } from "js-sha256"

/**
 * Generate a SHA256 hash of multiple text parameters
 * @param texts Variable number of text parameters
 * @returns SHA256 hexadecimal string
 *
 * @example
 * Sha256Hex('hello') // single parameter
 * Sha256Hex('hello', 'world') // multiple parameters joined with separator
 */
export function Sha256Hex(...texts: string[]): string {
  if (texts.length === 0) {
    throw new Error("At least one text parameter is required")
  }

  // Historical encoding. Use Sha256Fields for new semantic tuples; retain persisted keys.
  const combined = texts.join("|")
  return sha256(combined)
}

/** Versioned tuple encoding; JSON escaping also distinguishes empty fields and lone surrogates. */
export function Sha256Fields(...fields: string[]): string {
  if (!fields.length) throw new Error("At least one text parameter is required")
  return sha256(JSON.stringify(["read-frog:fields:v2", ...fields]))
}

/** Legacy lookup for a known fixed-arity identity only. Never guess ambiguous boundaries. */
export function safeLegacyFieldsHash(...fields: string[]): string | undefined {
  return fields.every((field) => !field.includes("|")) ? Sha256Hex(...fields) : undefined
}

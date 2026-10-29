import { browser } from "#imports"

export function isNonNullish<T>(value: T): value is NonNullable<T> {
  return value !== null && value !== undefined
}

export function getActiveTabUrl() {
  return browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]!.url)
}

/**
 * Get value from map; if not exists, create it with factory and return it.
 */

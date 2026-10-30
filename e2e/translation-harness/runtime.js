const values = new Map()
const watchers = new Map()
export const storage = {
  async getItem(key) {
    return structuredClone(values.get(key) ?? null)
  },
  async setItem(key, value) {
    const old = values.get(key)
    values.set(key, structuredClone(value))
    for (const cb of watchers.get(key) ?? []) cb(value, old)
  },
  async setMeta() {},
  watch(key, cb) {
    const list = watchers.get(key) ?? new Set()
    list.add(cb)
    watchers.set(key, list)
    return () => list.delete(cb)
  },
}
export const browser = {
  runtime: {
    id: "local-browser-harness",
    getManifest: () => ({ version: "0.2.5" }),
    getURL: (path) => `/${path}`,
  },
  i18n: { getUILanguage: () => "en", getMessage: (key) => key },
}

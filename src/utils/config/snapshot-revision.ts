import type { Config } from "@/types/config/config"
const revisions = new WeakMap<Config, number>()
export function copyConfigSnapshot(config: Config, revision: number): Config {
  const copy = structuredClone(config)
  revisions.set(copy, revision)
  return copy
}
/** Metadata on the returned copy; never reads storage or a later global version. */
export function getConfigSnapshotRevision(config: Config): number {
  return revisions.get(config) ?? 0
}

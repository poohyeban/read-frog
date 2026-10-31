import type { PerformanceOverrides } from "./performance-config"
import type { ResourcePolicy, ResourcePolicyOverrides } from "./resource-policy"
import type { ResourceDomainSpec } from "./resource-scheduler"
import { effectivePerformance } from "./performance-config"
import { resolveResourcePolicy } from "./resource-policy"

/** Physical identity and user grouping are independent of translation/cache identity. */
export function resolveResourceRegistry(
  identities: ReadonlyMap<string, string>,
  overrides: PerformanceOverrides,
) {
  const aliases = new Map<string, string[]>()
  for (const [provider, resource] of identities) {
    const members = aliases.get(resource) ?? []
    members.push(provider)
    aliases.set(resource, members)
  }
  const domains: ResourceDomainSpec[] = []
  const paths = new Map<string, readonly string[]>()
  const groups = new Map<string, string>()
  for (const [group, value] of Object.entries(overrides.groups ?? {}))
    for (const member of value.members) groups.set(member, group)
  for (const [resource, providers] of aliases) {
    // Only explicit alias overrides participate. A default alias must not undo
    // a deliberate higher limit on another name for the same physical account.
    const merged: ResourcePolicyOverrides = {}
    for (const provider of providers)
      for (const [key, value] of Object.entries(overrides.providers?.[provider] ?? {})) {
        const field = key as keyof ResourcePolicy
        const old = merged[field]
        const lowerIsStricter = !["baseRetryDelayMs", "cooldownMs", "priorityAgingMs"].includes(
          field,
        )
        merged[field] =
          old === undefined ? value : lowerIsStricter ? Math.min(old, value) : Math.max(old, value)
      }
    const group = groups.get(resource)
    const groupPolicy = group ? overrides.groups![group]!.policy : undefined
    // Group policy is the default for its members; explicit credential limits
    // remain an additional independent constraint.
    domains.push({ id: resource, policy: resolveResourcePolicy({ ...groupPolicy, ...merged }) })
    paths.set(resource, group ? [resource, `group:${group}`] : [resource])
  }
  for (const [id, group] of Object.entries(overrides.groups ?? {}))
    if (group.members.some((member) => aliases.has(member)))
      domains.push({ id: `group:${id}`, policy: resolveResourcePolicy(group.policy) })
  return { domains, paths, global: effectivePerformance(overrides).global }
}

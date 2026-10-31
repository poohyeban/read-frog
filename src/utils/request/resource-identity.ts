import { getRandomUUID } from "@/utils/crypto-polyfill"
import { ResourceRejected } from "./resource-error"

export interface IdentityMaterial {
  endpoint: string
  /** Already resolved effective authentication, never a display name or a model name. */
  authentication: Readonly<Record<string, string>>
  organization?: string
  project?: string
  /** Only a trusted adapter may supply a verified stable OAuth subject. Never decode an unverified JWT here. */
  stableAccount?: { issuer: string; subject: string; verified: boolean }
  restriction?: string
}
export interface IdentityVault {
  version: 1
  namespace: string
  secret: string
  resources: Record<string, string>
}
export interface IdentityPersistence {
  read: () => Promise<unknown>
  write: (value: IdentityVault) => Promise<void>
  hasBindings: () => Promise<boolean>
}

export function isIdentityVault(value: unknown): value is IdentityVault {
  if (!value || typeof value !== "object") return false
  const vault = value as IdentityVault
  if (
    vault.version !== 1 ||
    typeof vault.namespace !== "string" ||
    !/^[\da-f-]{36}$/i.test(vault.namespace) ||
    typeof vault.secret !== "string" ||
    !vault.resources ||
    typeof vault.resources !== "object" ||
    Array.isArray(vault.resources)
  )
    return false
  try {
    if (atob(vault.secret).length !== 32) return false
  } catch {
    return false
  }
  const resources = Object.entries(vault.resources)
  return (
    resources.length <= 4096 &&
    resources.every(
      ([key, id]) =>
        /^[\da-f]{64}$/i.test(key) && typeof id === "string" && /^[\da-f-]{36}$/i.test(id),
    )
  )
}

/** URL's host/default-port normalization is safe; path/query/tenant are deliberately preserved. */
export function normalizeResourceEndpoint(endpoint: string): string {
  const url = new URL(endpoint)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new ResourceRejected("identity")
  // SDK base URLs join paths after removing the final slash. Internal paths stay case sensitive.
  url.pathname = url.pathname.replace(/\/$/, "") || "/"
  return url.href
}

function materialKey(input: IdentityMaterial) {
  const stable = input.stableAccount?.verified ? input.stableAccount : undefined
  return JSON.stringify([
    normalizeResourceEndpoint(input.endpoint),
    stable
      ? [stable.issuer, stable.subject]
      : Object.entries(input.authentication).sort(([a], [b]) => a.localeCompare(b)),
    input.organization ?? "",
    input.project ?? "",
    input.restriction ?? "",
  ])
}

/** One background owner. No credential material escapes this resolver. */
export class ResourceIdentityResolver {
  private vault?: IdentityVault
  private key?: CryptoKey
  private initialization?: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  private pending = new Map<string, Promise<string>>()
  private snapshots = new Map<string, { revision: string; id: string }>()
  private latest = new Map<string, symbol>()
  private resolutions = 0
  constructor(private readonly persistence: IdentityPersistence) {}

  initialize(): Promise<void> {
    this.initialization ??= (async () => {
      const stored = await this.persistence.read()
      let vault: IdentityVault
      if (stored === null || stored === undefined) {
        if (await this.persistence.hasBindings()) throw new ResourceRejected("identity")
        const bytes = crypto.getRandomValues(new Uint8Array(32))
        vault = {
          version: 1,
          namespace: getRandomUUID(),
          secret: btoa(String.fromCharCode(...bytes)),
          resources: {},
        }
        await this.persistence.write(vault)
        const verified = (await this.persistence.read()) as IdentityVault | undefined
        if (verified?.secret !== vault.secret || verified?.namespace !== vault.namespace)
          throw new ResourceRejected("identity")
      } else {
        vault = stored as IdentityVault
        if (!isIdentityVault(vault)) throw new ResourceRejected("identity")
      }
      let bytes: Uint8Array<ArrayBuffer>
      try {
        bytes = Uint8Array.from(atob(vault.secret), (c) => c.charCodeAt(0))
      } catch {
        throw new ResourceRejected("identity")
      }
      if (bytes.length !== 32) throw new ResourceRejected("identity")
      this.key = await crypto.subtle.importKey(
        "raw",
        bytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      )
      this.vault = vault
    })().catch((error) => {
      this.initialization = undefined
      throw error
    })
    return this.initialization
  }

  /** Called on provider configuration changes, not per frame or per remote request. */
  async update(providerId: string, revision: string, material: IdentityMaterial): Promise<string> {
    const ticket = Symbol(providerId)
    this.latest.set(providerId, ticket)
    const cached = this.snapshots.get(providerId)
    if (cached?.revision === revision) return cached.id
    // Serialize the effective credential material before the first asynchronous boundary.
    const input = materialKey(material)
    await this.initialize()
    let operation = this.pending.get(input)
    if (!operation) {
      operation = this.identify(input)
      this.pending.set(input, operation)
      void operation
        .finally(() => {
          this.pending.delete(input)
        })
        .catch(() => {})
    }
    const id = await operation
    if (this.latest.get(providerId) === ticket) this.snapshots.set(providerId, { revision, id })
    return id
  }
  get(providerId: string, revision: string): string | undefined {
    const snapshot = this.snapshots.get(providerId)
    return snapshot?.revision === revision ? snapshot.id : undefined
  }
  remove(providerId: string) {
    this.latest.delete(providerId)
    this.snapshots.delete(providerId)
  }
  get resolutionCount() {
    return this.resolutions
  }

  private async identify(material: string) {
    this.resolutions++
    const signed = new Uint8Array(
      await crypto.subtle.sign("HMAC", this.key!, new TextEncoder().encode(material)),
    )
    const digest = Array.from(signed, (b) => b.toString(16).padStart(2, "0")).join("")
    const operation = this.writes.then(async () => {
      const known = this.vault!.resources[digest]
      if (known) return known
      if (Object.keys(this.vault!.resources).length >= 4096) throw new ResourceRejected("identity")
      const id = getRandomUUID()
      const next = { ...this.vault!, resources: { ...this.vault!.resources, [digest]: id } }
      // Persist before publishing: a failed write cannot leave an unstable runtime-only identity.
      await this.persistence.write(next)
      this.vault = next
      return id
    })
    this.writes = operation.catch(() => {})
    return operation
  }
}

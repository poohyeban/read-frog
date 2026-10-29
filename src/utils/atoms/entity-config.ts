import type { APIProviderConfig } from "@/types/config/provider"
import { atom } from "jotai"
import { isAPIProviderConfig } from "@/types/config/provider"
import { writeConfigAtom } from "./config"

export const patchProviderConfigAtom = atom(
  null,
  async (_get, set, { id, changes }: { id: string; changes: Partial<APIProviderConfig> }) => {
    await set(writeConfigAtom, (current) => {
      const provider = current.providersConfig.find((item) => item.id === id)
      if (!provider || !isAPIProviderConfig(provider)) throw new Error("Provider no longer exists")
      const next = { ...provider, ...changes, id } as APIProviderConfig
      return {
        providersConfig: current.providersConfig.map((item) => (item.id === id ? next : item)),
      }
    })
  },
)

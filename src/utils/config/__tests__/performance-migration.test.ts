import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { PERFORMANCE_STORAGE_KEY } from "@/utils/request/performance-config"
const mock = vi.hoisted(() => ({
  read: vi.fn<(...args: any[]) => any>(),
  write: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("wxt/utils/storage", () => ({ storage: { getItem: mock.read, setItem: mock.write } }))
vi.mock("#imports", () => ({ storage: { getItem: mock.read, setItem: mock.write } }))
import { migratePerformanceConfig } from "../performance-migration"

beforeEach(() => {
  mock.read.mockReset()
  mock.write.mockReset()
})
describe("sparse legacy resource migration", () => {
  it("does not persist known historical defaults", async () => {
    await migratePerformanceConfig(structuredClone(DEFAULT_CONFIG), 5)
    expect(mock.write).not.toHaveBeenCalled()
  })
  it("preserves explicit concurrency, diagnostics and queue settings without financial fields", async () => {
    const config = structuredClone(DEFAULT_CONFIG)
    Object.assign(config.videoSubtitles, {
      workBudget: { requests: 1, estimatedTokens: 1, maxInFlight: 4, diagnostics: true },
    })
    Object.assign(config.videoSubtitles.requestQueueConfig, { rate: 12 })
    Object.assign(config.videoSubtitles.batchQueueConfig, { maxItemsPerBatch: 7 })
    const before = structuredClone(config)
    await migratePerformanceConfig(config, 5)
    const [key, result] = mock.write.mock.calls[0]!
    expect(key).toBe(PERFORMANCE_STORAGE_KEY)
    expect(result.providers[config.videoSubtitles.providerId]).toEqual({ rate: 12, maxInFlight: 4 })
    expect(result.subtitles).toEqual({ diagnostics: true })
    expect(result.batches.subtitles).toEqual({ maxItemsPerBatch: 7 })
    expect(JSON.stringify(result)).not.toMatch(/requests|estimatedTokens|emergencyPercent/)
    expect(config).toEqual(before)
  })
  it("preserves unknown historical effective values, and never overwrites an existing override", async () => {
    const config = structuredClone(DEFAULT_CONFIG)
    mock.read.mockResolvedValue({
      version: 1,
      revision: 4,
      providers: { [config.pageTranslation.providerId]: { rate: 19 } },
    })
    await migratePerformanceConfig(config, 2)
    expect(mock.write.mock.calls[0]![1].providers[config.pageTranslation.providerId].rate).toBe(19)
  })
  it("does not rerun after the schema migration", async () => {
    await migratePerformanceConfig(structuredClone(DEFAULT_CONFIG), 6)
    expect(mock.read).not.toHaveBeenCalled()
    expect(mock.write).not.toHaveBeenCalled()
  })
})

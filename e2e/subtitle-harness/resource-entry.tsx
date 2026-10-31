import { Dexie } from "dexie"
import { SubtitleWorkRuntime } from "@/entrypoints/background/subtitle-work"
import { createPerformanceWriter } from "@/utils/config/performance-writer"
import AppDB from "@/utils/db/dexie/app-db"
import { emptyPerformanceOverrides } from "@/utils/request/performance-config"
import { resolveResourcePolicy } from "@/utils/request/resource-policy"
import { ResourceScheduler } from "@/utils/request/resource-scheduler"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
;(window as any).runSubtitleBenchmark = async () => {
  const checks: Record<string, boolean> = {}
  await Dexie.delete("ReadFrogLiteDB")
  const legacy = new Dexie("ReadFrogLiteDB")
  legacy.version(5).stores({
    translationCache: "key,createdAt",
    articleSummaryCache: "key,createdAt",
    glossary: "id,createdAt,enabled",
    glossaryTerm: "id,glossaryId,&[glossaryId+targetLang+matchKey],enabled,updatedAt",
    aiSegmentationCache: "key,createdAt",
    subtitleCandidates: "key,trackKey,createdAt",
    subtitleBudget: "key",
    subtitleAttempt: "key",
  })
  await legacy.open()
  await legacy
    .table("translationCache")
    .put({ key: "preserved", translation: "保存译文", createdAt: new Date() })
  await legacy
    .table("glossary")
    .put({ id: "user", name: "User glossary", createdAt: new Date(), enabled: true })
  await legacy
    .table("aiSegmentationCache")
    .put({ key: "segmentation", result: "saved segmentation", createdAt: new Date() })
  await legacy.table("subtitleBudget").put({ key: "obsolete", usedCalls: 99 })
  legacy.close()
  const db = new AppDB()
  await db.open()
  checks.obsoleteAccountingRemoved = !db.tables.some((table) =>
    ["subtitleBudget", "subtitleAttempt"].includes(table.name),
  )
  checks.translationPreserved =
    (await db.translationCache.get("preserved"))?.translation === "保存译文"
  checks.glossaryPreserved = (await db.glossary.get("user"))?.name === "User glossary"
  checks.segmentationPreserved =
    (await db.aiSegmentationCache.get("segmentation"))?.result === "saved segmentation"
  checks.indexUpgraded = db.subtitleCandidates.schema.indexes.some(
    (index) => index.name === "[trackKey+start]",
  )
  db.close()

  const runtime = new SubtitleWorkRuntime()
  const scheduler = new ResourceScheduler()
  scheduler.configure(
    [{ id: "account", policy: resolveResourcePolicy({ maxInFlight: 1 }) }],
    new Map([["account", ["account"]]]),
  )
  let afterStopStarts = 0
  for (let cycle = 0; cycle < 100; cycle++) {
    const lease = runtime.open(1)
    const scope = `cycle-${cycle}`
    runtime.register(1, scope, {
      lease,
      lane: "fast",
      start: 0,
      end: 1000,
      urgent: true,
      logicalKey: scope,
    })
    const guard = runtime.guard(() => [scope], [scope])
    await guard.beforeCall("bounded", 128)
    let finish!: () => void
    const preparation = new Promise<void>((resolve) => {
      finish = resolve
    })
    const pending = scheduler.run(
      { resourceId: "account", consumer: "playback" },
      async (_signal, permit) => {
        await preparation
        permit.start(guard.onDispatch)
        afterStopStarts++
      },
    )
    const result = Promise.allSettled([pending])
    runtime.revoke(1, lease)
    finish()
    await result
  }
  checks.stop100ZeroStarts = afterStopStarts === 0 && scheduler.counters.starts === 0
  const exportLease = runtime.open(1)
  const playbackLease = runtime.open(1)
  runtime.register(1, "export", {
    lease: exportLease,
    lane: "export",
    start: 0,
    end: 1000,
    urgent: false,
    logicalKey: "explicit-export",
  })
  runtime.revoke(1, playbackLease)
  const guard = runtime.guard(() => ["export"], ["export"])
  await guard.beforeCall("bounded export", 128)
  await scheduler.run({ resourceId: "account", consumer: "export" }, async (_signal, permit) =>
    permit.start(guard.onDispatch),
  )
  checks.independentExport = scheduler.counters.starts === 1
  runtime.revoke(1, exportLease)
  const restarted = new SubtitleWorkRuntime()
  checks.workerRestartInvalidatesLeases = !restarted.hasLease(1, exportLease)
  await tick()
  checks.noResourceLeaks =
    scheduler.inspect().active === 0 &&
    scheduler.inspect().queued === 0 &&
    scheduler.inspect().timers === 0

  let overrides = emptyPerformanceOverrides(),
    writes = 0
  const writer = createPerformanceWriter({
    read: async () => structuredClone(overrides),
    write: async (value) => {
      overrides = value
      writes++
    },
    context: async () => ({ identities: new Map([["a", "account"]]), providerIds: new Set(["a"]) }),
  })
  await writer.patch({ kind: "reset", target: { section: "provider", id: "a" } })
  checks.defaultResetDoesNotWrite = writes === 0
  await Promise.all([
    writer.patch({
      kind: "set",
      target: { section: "provider", id: "a" },
      field: "maxInFlight",
      value: 1,
    }),
    writer.patch({
      kind: "set",
      target: { section: "provider", id: "a" },
      field: "rate",
      value: 2,
    }),
    writer.patch({
      kind: "set",
      target: { section: "subtitles" },
      field: "diagnostics",
      value: true,
    }),
  ])
  checks.concurrentSettingsMerge =
    overrides.providers?.a?.maxInFlight === 1 &&
    overrides.providers?.a?.rate === 2 &&
    overrides.subtitles?.diagnostics === true
  return {
    checks,
    afterStopStarts,
    starts: scheduler.counters.starts,
    diagnostics: runtime.snapshot(),
    storedSettingsWrites: writes,
    note: "Real Chromium IndexedDB upgrade and production lease/scheduler/config writer. All provider executions are local mocks; real usage unavailable.",
  }
}

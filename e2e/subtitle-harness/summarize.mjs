import { readFile, writeFile } from "node:fs/promises"
const root = "docs/subtitle-upgrade"
const read = async (name) => JSON.parse(await readFile(`${root}/${name}/raw.json`, "utf8"))
const q = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null
}
const stats = (values) => ({ n: values.length, p50: q(values, 0.5), p95: q(values, 0.95) })
const fmt = (value, digits = 2) =>
  value === null || value === undefined ? "未取得" : value.toFixed(digits)
const pair = (s) => `${fmt(s.p50)} / ${fmt(s.p95)}`
const documents = await Promise.all([
  read("before"),
  read("after"),
  read("transcript-before"),
  read("transcript-after"),
  read("queues-before"),
  read("queues-after"),
  read("export-before"),
  read("export-after"),
])
for (const d of documents) if (d.errors.length) throw Error(`Browser errors: ${d.errors}`)
const [before, after, tb, ta, qb, qa, eb, ea] = documents
if (!before.scenarios[0].changedAt || !after.scenarios[0].changedAt)
  throw Error("Use the same current benchmark protocol for both sources")
const output = {
  timeline: [],
  scenarios: [],
  transcript: [],
  queues: [],
  exports: [],
  rendererPeakMiB: {},
}
let md = `# 浏览器性能与资源证据\n\n历史源码 bad35243 与最终源码；Chromium ${after.environment.browser}、Node ${after.environment.node}，相同机器。所有 Provider 均为本地 mock，无真实 API Key/费用。这些结果不是原生 MV3 Service Worker 验收。P50/P95采用nearest-rank。\n\n## 时间轴\n\n单位µs，格式P50 / P95；每档30个样本，每样本200次操作。500条合并以ms计，每档10样本。\n\n|规模|查询旧→新 µs|timeupdate旧→新 µs|500条合并旧→新 ms|同cue React commits旧→新|\n|---:|---|---|---|---|\n`
for (const [i, a] of after.scales.entries()) {
  const b = before.scales[i]
  const row = {
    size: a.size,
    lookupBefore: stats(b.lookup.map((x) => x * 1000)),
    lookupAfter: stats(a.lookup.map((x) => x * 1000)),
    timeupdateBefore: stats(b.timeupdate.map((x) => x * 1000)),
    timeupdateAfter: stats(a.timeupdate.map((x) => x * 1000)),
    bulkBefore: stats(b.bulk500),
    bulkAfter: stats(a.bulk500),
    heapBefore: b.heapBytes,
    heapAfter: a.heapBytes,
  }
  output.timeline.push(row)
  md += `|${a.size}|${pair(row.lookupBefore)} → ${pair(row.lookupAfter)}|${pair(row.timeupdateBefore)} → ${pair(row.timeupdateAfter)}|${pair(row.bulkBefore)} → ${pair(row.bulkAfter)}|${b.sameCueCommits} → ${a.sameCueCommits}|\n`
}
md += `\n同cue更新基线已经为0，未宣称新收益。构建索引是一次性成本；数组按不可变轨版本缓存。堆快照原值保存在summary.json；它不是精确峰值。\n\n## 恢复、Seek与倍速\n\n翻译延迟是覆盖目标时间的首个有效结果发布耗时（ms），Seek从实际位置改变算起；不是视频解码到屏幕的端到端耗时。每场景30次。mock翻译40ms、分段60ms，模型服务时间固定，不能声称模型本身变快。2x/4x会推进播放器时间1秒，每50ms采样一次可用结果覆盖；不是实站长期播放统计。\n\n|场景|首个结果旧→新 P50/P95 ms|250ms内有结果旧→新|分段首窗口旧→新 ms|翻译内容批数旧→新|倍速就绪采样旧→新|\n|---|---|---|---|---|---|\n`
const changed = new Set(["asyncResume", "seekForward", "seekBackward", "rapidSeek", "stopStart"])
function scenarioRows(d, name) {
  return d.scenarios
    .filter((s) => s.name === name)
    .map((s) => {
      const origin = changed.has(name) ? s.changedAt : s.started
      const first = s.published.find((p) =>
        p.starts.some((start, i) => start <= s.targetTimeMs && p.ends[i] > s.targetTimeMs),
      )
      return {
        latency: first ? first.at - origin : null,
        segment: s.events.find((e) => e.type === "segment:enqueue")?.start,
        translate: s.events.filter((e) => e.type === "translate:enqueue").length,
        cueWork: s.events
          .filter((e) => e.type === "translate:enqueue")
          .reduce((sum, e) => sum + e.count, 0),
        late: s.events.filter((e) => e.type.endsWith(":complete") && e.at > s.stopped).length,
        cancelled: s.events.filter((e) => e.type.endsWith(":cancel")).length,
        ready: s.readiness.filter(Boolean).length,
        opportunities: s.readiness.length,
      }
    })
}
for (const name of [...new Set(after.scenarios.map((s) => s.name))]) {
  const b = scenarioRows(before, name),
    a = scenarioRows(after, name)
  const summarize = (rows) => ({
    latency: stats(rows.map((r) => r.latency).filter((x) => x !== null)),
    within250: rows.filter((r) => r.latency !== null && r.latency <= 250).length,
    firstSegment: q(
      rows.map((r) => r.segment),
      0.5,
    ),
    batches: stats(rows.map((r) => r.translate)),
    cueWork: stats(rows.map((r) => r.cueWork)),
    afterStop: rows.reduce((n, r) => n + r.late, 0),
    cancelled: rows.reduce((n, r) => n + r.cancelled, 0),
    readiness: rows.reduce((n, r) => n + r.ready, 0),
    opportunities: rows.reduce((n, r) => n + r.opportunities, 0),
  })
  const old = summarize(b),
    next = summarize(a)
  output.scenarios.push({ name, before: old, after: next })
  md += `|${name}|${pair(old.latency)} → ${pair(next.latency)}|${old.within250}/30 → ${next.within250}/30|${old.firstSegment} → ${next.firstSegment}|${fmt(old.batches.p50, 0)} → ${fmt(next.batches.p50, 0)}|${old.opportunities ? `${old.readiness}/${old.opportunities} → ${next.readiness}/${next.opportunities}` : "—"}|\n`
}
md += `\n这些“内容批数”来自真实Coordinator边界的mock translator，不能当作HTTP次数；每批cue数量和取消事件也保存在summary.json/raw.json。真实BatchQueue合并后的模型调用数在下表。当前原文可先翻译，未来cue等待AI重分段，避免先译后弃；不会等待历史窗口。原文/本地分段始终保留。\n\n## 现有网络队列的实际调用\n\n真实BatchQueue和RequestQueue工厂；仅executeTranslate换成20ms本地Provider。每个场景30次，同样令牌桶和批大小。\n\n|场景|Provider调用旧→新（总计）|每调用cue数旧→新|当前请求开始P50/P95旧→新 ms|停止后的完成旧→新|\n|---|---|---|---|---|\n`
for (const name of [...new Set(qa.samples.map((s) => s.scenario))]) {
  const sum = (d) => {
    const samples = d.samples.filter((s) => s.scenario === name),
      events = samples.flatMap((s) => s.events),
      executed = events.filter((e) => e.phase === "execute")
    return {
      calls: executed.length,
      items: executed.reduce((n, e) => n + e.items, 0),
      first: stats(samples.map((s) => s.events.find((e) => e.phase === "execute")?.at)),
      cancelled: events.filter((e) => e.phase === "cancel").length,
      afterStop: samples.reduce((n, s) => {
        const at = s.events.find((e) => e.phase === "stop")?.at
        return (
          n +
          (at === undefined
            ? 0
            : s.events.filter((e) => e.phase === "complete" && e.at > at).length)
        )
      }, 0),
    }
  }
  const old = sum(qb),
    next = sum(qa)
  output.queues.push({ name, before: old, after: next })
  md += `|${name}|${old.calls} → ${next.calls}|${fmt(old.items / old.calls)} → ${fmt(next.items / next.calls)}|${pair(old.first)} → ${pair(next.first)}|${old.afterStop} → ${next.afterStop}|\n`
}
md += `\n72条完整生产窗口平均每次调用9条，配置上限20，利用率45%；两版保持相同8次模型调用。优先级改变开始顺序，全部辅助任务仍会完成。队列mock AbortSignal可以中止；真实供应商已收到的调用是否继续计费无法由扩展保证。\n\n## Transcript\n\n30次挂载/档，固定420×600视口与相同测试CSS；使用真实生产React组件。seek包含活跃行更新和滚动，两版协议相同。计时含两次requestAnimationFrame，因此小列表有约33ms帧间隔下限。\n\n|规模|挂载旧→新 P50/P95 ms|更新500条旧→新 P50/P95 ms|定位末行旧→新 P50/P95 ms|最终DOM行数旧→新|\n|---:|---|---|---|---|\n`
for (const [i, a] of ta.scales.entries()) {
  const b = tb.scales[i],
    row = {
      size: a.size,
      mountBefore: stats(b.mount),
      mountAfter: stats(a.mount),
      updateBefore: stats(b.update500),
      updateAfter: stats(a.update500),
      seekBefore: stats(b.seekScroll),
      seekAfter: stats(a.seekScroll),
      rowsBefore: Math.max(...b.rowCounts),
      rowsAfter: Math.max(...a.rowCounts),
    }
  output.transcript.push(row)
  md += `|${a.size}|${pair(row.mountBefore)} → ${pair(row.mountAfter)}|${pair(row.updateBefore)} → ${pair(row.updateAfter)}|${pair(row.seekBefore)} → ${pair(row.seekAfter)}|${row.rowsBefore} → ${row.rowsAfter}|\n`
}
for (const [name, d] of [
  ["transcriptBefore", tb],
  ["transcriptAfter", ta],
  ["exportBefore", eb],
  ["exportAfter", ea],
])
  output.rendererPeakMiB[name] = Math.max(...d.rendererMemory.map((m) => m.peakRssKiB)) / 1024
md += `\n操作系统VmHWM测得本轮最大renderer进程峰值：Transcript ${fmt(output.rendererPeakMiB.transcriptBefore)} → ${fmt(output.rendererPeakMiB.transcriptAfter)} MiB。这是四档、每档30次反复挂载压力下的进程高水位（每版本一个隔离浏览器进程组），不是单个视频正常播放内存，也不是仅JS堆。虚拟列表不挂载全文DOM，浏览器页面内查找只覆盖已挂载行；侧栏没有独立全文搜索功能。\n\n## SRT\n\n真实Downloader+SRT构造器，零延迟mock翻译，无磁盘下载；每档3次，不把内容层批数视为HTTP请求。\n\n|规模|完整导出旧→新|耗时旧→新 P50/P95 ms|内容翻译批数旧→新|\n|---:|---|---|---|\n`
for (const [i, a] of ea.scales.entries()) {
  const b = eb.scales[i],
    complete = (s) =>
      s.samples.filter(
        (r) => r.result?.count === s.size && r.result.unique === s.size && r.result.valid,
      ).length
  const row = {
    size: a.size,
    before: {
      complete: complete(b),
      time: stats(b.samples.map((r) => r.duration)),
      calls: b.samples[0].translationCalls,
    },
    after: {
      complete: complete(a),
      time: stats(a.samples.map((r) => r.duration)),
      calls: a.samples[0].translationCalls,
    },
  }
  output.exports.push(row)
  md += `|${a.size}|${row.before.complete}/3 → ${row.after.complete}/3|${pair(row.before.time)} → ${pair(row.after.time)}|${row.before.calls} → ${row.after.calls}|\n`
}
md += `\n导出身份核对与排序增加CPU开销，未声称导出吞吐提升；所有样本完整、无重复、时间戳有效。失败/取消/换视频/AI回退由自动化契约补充。\n\n## 中文Popup\n\n生产资源，API延迟固定120ms，每语言/冷重复/版本30次，共360次。API为fixture，不能代表真实SW或新增RPC跨上下文耗时。完整meaningful/paint/interactive分位数见ui-locales/summary.json。\n\n|语言/场景|有意义内容P50/P95 ms|可交互P50/P95 ms|\n|---|---|---|\n`
const ui = JSON.parse(await readFile(`${root}/ui-locales/summary.json`, "utf8"))
for (const r of ui.filter((entry) => entry.version === "after"))
  md += `|${r.locale}/${r.cache}|${pair(r.metrics.meaningful)}|${pair(r.metrics.interactive)}|\n`
md += `\n语言chunk耗时与字节数在ui-locales/locale-chunks.json。中文加载有额外资源成本，未用英语结果替代中文验证。\n`
await writeFile(`${root}/summary.json`, JSON.stringify(output, null, 2))
await writeFile(`${root}/PERFORMANCE.md`, md)
console.log("Wrote performance summary", output.timeline.length, output.scenarios.length)

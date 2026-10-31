"""Summarize copied acceptance artifacts; no Provider or network access."""
import json
import math
import pathlib
import statistics
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'docs/lite/resource-scheduler/evidence')
def read(name):
    return json.loads((root / (name + '.json')).read_text())
def quantiles(values):
    values = sorted(value for value in values if value is not None)
    return {'p50': statistics.median(values), 'p95': values[math.ceil(len(values) * .95) - 1]} if values else None
def matrix(name):
    data = read(name)
    rows = data['samples']
    main = [r for r in rows if r['mode'] == 'dual' and not r['failure'] and 'requestRate' not in r]
    after = {m['name']: m['value'] for m in data['browserMetrics']['after']}
    before = {m['name']: m['value'] for m in data['browserMetrics']['before']}
    return {
        'scenarios': len(rows),
        'requests': sum(r['requests'] for r in rows),
        'estimatedInputTokens': sum(r['estimatedInputTokens'] for r in rows),
        'realUsage': None,
        'cancelledTransports': sum(r['cancelled'] for r in rows),
        'scheduledRetries': sum(r['retries'] for r in rows),
        'cacheWindowRestorations': sum(r['cacheHits'] for r in rows),
        'admissionRejections': sum(r.get('resources', {}).get('counters', {}).get('rejected', 0) for r in rows) if name.endswith('current') else None,
        'afterStopRequests': sum(r['afterStopRequests'] for r in rows),
        'concurrencyViolations': sum(r['peakActive'] > r['concurrency'] for r in rows),
        'residualActive': sum(r['resources']['active'] for r in rows),
        'firstCaptionMs': quantiles(r['firstMs'] for r in main),
        'firstCaptionMissingWithinObservation': sum(r['firstMs'] is None for r in main),
        'rendererCpuSeconds': data['rendererCpuSeconds'],
        'peakRendererRssMiB': max(r['peakRssKiB'] for r in data['rendererMemory']) / 1024,
        'heapMiB': after['JSHeapUsedSize'] / 1024**2,
        'taskSeconds': after['TaskDuration'] - before['TaskDuration'],
        'scriptSeconds': after['ScriptDuration'] - before['ScriptDuration'],
        'concurrencyMeanReadiness': {str(c): statistics.mean(r['readyBeforeDisplay'] for r in main if r['concurrency'] == c) for c in [1, 2, 4, 8]},
        'defaultNormalLatency': [r for r in main if r['concurrency'] == 2 and r['latency'] == 1000 and r['density'] == 1],
        'warmQuality': [r for r in rows if r['mode'] == 'quality-cache'],
        'rateBurstTuning': rows[-12:],
    }
def transcript(name):
    data = read(name)
    return {'rendererCpuSeconds': data['rendererCpuSeconds'], 'scales': [{
        'size': row['size'],
        **{key: quantiles(row[key]) for key in ['mount', 'update500', 'seekScroll']},
        'maxMountedRows': max(row['rowCounts']),
        'heapPeakMiB': max(row['heaps']) / 1024**2,
    } for row in data['scales']]}
def timeline(name):
    data = read(name)
    return [{'size': row['size'], **{key: quantiles(row[key]) for key in ['lookup', 'timeupdate', 'bulk500']}, 'sameCueCommits': row['sameCueCommits']} for row in data['scales']]
def exports(name):
    data = read(name)
    return [{'size': row['size'], 'durationMs': quantiles(r['duration'] for r in row['samples']),
        'callsPerExport': row['samples'][0]['translationCalls'],
        'complete': all(r['result']['valid'] and r['result']['count'] == row['size'] and r['result']['unique'] == row['size'] for r in row['samples'])} for row in data['scales']]
result = {name: fn(name) for fn, prefix in [(matrix, 'matrix'), (transcript, 'transcript'), (timeline, 'timeline'), (exports, 'export')] for name in [prefix+'-baseline', prefix+'-current']}
(root / 'summary.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(root / 'summary.json')

old = result['matrix-baseline']
new = result['matrix-current']
lines = ['# Mock 性能与资源指标', '', '基线：`fddc448e72cca5aa3007fcf27ab15c378288c844`。数值来自 evidence 目录原始 JSON。所有请求均由本地 Mock Provider 处理。', '', '## 165 场景矩阵', '', '| 指标 | v2 基线 | 当前实现 |', '| --- | ---: | ---: |']
fields = [('模型实际开始次数', 'requests'), ('源文输入 Token 估算单位', 'estimatedInputTokens'), ('取消的 Mock 传输', 'cancelledTransports'), ('安排的重试次数', 'scheduledRetries'), ('候选缓存窗口恢复次数', 'cacheWindowRestorations'), ('停止确认后的请求开始数', 'afterStopRequests'), ('实际并发越界场景', 'concurrencyViolations'), ('收尾后仍占用许可', 'residualActive'), ('渲染进程 CPU（秒）', 'rendererCpuSeconds'), ('主渲染进程峰值 RSS（MiB）', 'peakRendererRssMiB'), ('结束时 JS Heap（MiB）', 'heapMiB'), ('CDP 主线程任务时间（秒）', 'taskSeconds'), ('CDP 脚本时间（秒）', 'scriptSeconds')]
for title, key in fields:
    fmt = lambda value: f'{value:,}' if isinstance(value, int) else f'{value:,.3f}'
    lines.append(f'| {title} | {fmt(old[key])} | {fmt(new[key])} |')
lines += ['', '实际 usage：均不可得（`null`）；Mock 输入估算采用源文 UTF-8 字节数 + 64，并不含真实 Provider 的完整提示词，也不是美元费用。预热 Quality 的 1x/2x/4x 场景中，两版各 4 次候选查询均命中（100%），模型请求与回放新增请求均为 0；这不是所有用户场景的总体缓存命中率。当前矩阵资源准入拒绝为 0；旧版没有相同口径的共享准入计数。累计预算拒绝已不适用：该系统已删除。取消数是传输取消，逻辑订阅取消另见生命周期数据。', '', '矩阵使用虚拟播放时钟，CPU、CDP 任务耗时和 RSS 来自真实 Chromium；每个场景使用共享字幕会话并在结束时销毁。每种组合一个样本，用于发现瓶颈和约束验证，不代表所有机器/模型的统计保证。', '', f'成功取得初始字幕的场景首句 P50/P95：基线 {old["firstCaptionMs"]["p50"]:.0f}/{old["firstCaptionMs"]["p95"]:.0f} ms，当前 {new["firstCaptionMs"]["p50"]:.0f}/{new["firstCaptionMs"]["p95"]:.0f} ms。144 个常规压力组合中，两版各有 {new["firstCaptionMissingWithinObservation"]} 个组合未在 30 秒观察窗取得初始字幕；这些缺失值未混入延迟分位数。慢 Provider 与高倍速无法通过本地调度消除吞吐量不足。', '', '### 默认并发 2、正常字幕密度、Mock 延迟 1 秒', '', '| 倍速 | 基线就绪率 | 当前就绪率 | 当前提前 2/3/5 秒就绪率 | 请求数：旧 → 新 |', '| --- | ---: | ---: | --- | ---: |']
for a, b in zip(old['defaultNormalLatency'], new['defaultNormalLatency']):
    ahead = ' / '.join(f'{b["readyAhead"][str(t)]*100:.1f}%' for t in [2, 3, 5])
    lines.append(f'| {b["rate"]}x | {a["readyBeforeDisplay"]*100:.1f}% | {b["readyBeforeDisplay"]*100:.1f}% | {ahead} | {a["requests"]} → {b["requests"]} |')
lines += ['', '### 并发默认值校验', '', '| 实际并发 | 基线平均就绪率 | 当前平均就绪率 |', '| --- | ---: | ---: |']
for c in ['1', '2', '4', '8']:
    lines.append(f'| {c} | {old["concurrencyMeanReadiness"][c]*100:.2f}% | {new["concurrencyMeanReadiness"][c]*100:.2f}% |')
lines += ['', '默认 2 保留低资源占用；有能力的 Provider 可以提高至 4 或更高。此矩阵从 4 提高到 8 的收益很小，不能作为所有 Provider 的通用推荐。单并发下先准备 Fast 缓冲带来明确改善。', '', '### 4x 高密度、100 ms Mock 的速率/突发校验', '', '| requests/sec | 突发容量 | 当前就绪率 | 提前 5 秒就绪率 | 请求数 |', '| ---: | ---: | ---: | ---: | ---: |']
for row in new['rateBurstTuning']:
    lines.append(f'| {row["requestRate"]} | {row["burst"]} | {row["readyBeforeDisplay"]*100:.1f}% | {row["readyAhead"]["5"]*100:.1f}% | {row["requests"]} |')
lines += ['', '保留参考默认 8 req/s、突发 20；提高到 16 没有稳定收益。3 次总尝试由实际 SDK/批次错误恢复测试验证，包含首次请求。它们均可修改；超时和退避默认值是有限的操作策略，未宣称对每个服务商最优。', '', '## 时间轴与 React', '', '| 50,000 条字幕指标（ms） | 基线 P50 / P95 | 当前 P50 / P95 |', '| --- | ---: | ---: |']
for kind, fields in [('timeline', ['lookup', 'timeupdate', 'bulk500']), ('transcript', ['mount', 'update500', 'seekScroll'])]:
    a = result[kind+'-baseline'] if kind == 'timeline' else result[kind+'-baseline']['scales']
    b = result[kind+'-current'] if kind == 'timeline' else result[kind+'-current']['scales']
    for field in fields:
        lines.append(f'| {kind}.{field} | {a[-1][field]["p50"]:.4f} / {a[-1][field]["p95"]:.4f} | {b[-1][field]["p50"]:.4f} / {b[-1][field]["p95"]:.4f} |')
lines += ['', '同一字幕内 30 次时间更新引发的额外 React 提交：两版均为 0。Transcript 各规模 30 个样本；50,000 行仍只挂载约十余行。浏览器滚动锚点回归另有 1.5 秒的有限布局稳定等待，不将其伪装成 35 ms 的锚点恢复保证。', '', '## 完整 SRT 本地组装', '', '| 字幕条数 | 每次导出翻译批次 | 基线 P50 / P95（ms） | 当前 P50 / P95（ms） | 完整性 |', '| ---: | ---: | ---: | ---: | --- |']
for a, b in zip(result['export-baseline'], result['export-current']):
    lines.append(f'| {b["size"]:,} | {b["callsPerExport"]:,} | {a["durationMs"]["p50"]:.1f} / {a["durationMs"]["p95"]:.1f} | {b["durationMs"]["p50"]:.1f} / {b["durationMs"]["p95"]:.1f} | {b["complete"]} |')
lines += ['', '每规模 3 次，P95 实际为这 3 次中的最大值。导出使用即时 Mock 翻译与预分段源轨，测量本地分批、校验和组装，未测真实网络耗时。翻译批次与实际 SDK 调用数应区分；真实分段失败、部分结果、取消与重试上界由专项测试覆盖。', '']
(root.parent / 'METRICS.md').write_text('\n'.join(lines))

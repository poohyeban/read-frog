# 字幕可靠性、缓存调度与流式实验

基线与远端重新核对为 `2d22b43bfe58571ed593be27dc4f6e99a68f98b5`。本轮仅本地分阶段提交，所有模型使用 Mock。不会自动推送、创建 PR、启动 Actions、发布或更换扩展 ID。

## 阶段 1：失败状态与尝试预算

独立复现两个问题：两分钟期限到达后未使用的安全重试也永久阻止；长 Retry-After 直接变成 Infinity。Seek 离开/回来、长时间隐藏、Stop/Start 的确定性时钟测试均复现。另确认 adapter 的通用 resume 会 clearFailed，从而让自动恢复隐式重置预算。

改动：`recovery.ts` 删除把墙钟期限作为永久屏蔽条件的逻辑，以 clear/waiting/ready/exhausted/manual/cancelled 表达失败状态。首次安全准入失败后最多两次延迟业务恢复，退避 1/2 秒并尊重更长 Retry-After；次数跨 Seek、显隐、暂停和自动 resume 保留。已耗尽 Provider 尝试、模糊传输失败、取消和永久错误不会仅因时间经过而恢复。仅用户明确启用/快捷键重试会清理失败，语义配置/术语变化仍按既有机制建立新会话；非语义设置刷新不重新分配预算。

成功或经验证的历史缓存移除对应失败状态，分段与摘要沿用同一时钟/分类；取消、成功和显式清除重新计算或清除定时器。超长等待使用有界 timer 分段，避免 32 位 timeout 溢出。

物理请求上界不变：每个翻译/分段/摘要逻辑操作仍由自己的 AttemptContext 和 RequestQueue 限制（默认 maxAttempts=3）；明确未发送的准入恢复最多 2 次，消耗 0 个物理许可。未知是否已发送的 RPC/流错误及队列耗尽带 retryExhausted，不获得新的业务额度。长 429 若物理策略已结束请求，仍保持 exhausted，不因 Retry-After 到期自动铸造额度。

红灯见 `evidence/stage1-before.txt`，绿灯见 `stage1-after.txt`。长时间离开后未花掉的恢复由永久空白变为返回窗口后执行一次；耗尽后无新增请求。只改变故障路径，正常成功路径请求/IPC/Token 不变。状态查询仍 O(1)，移除每条记录的过期时间字段；不新增轮询或常驻 worker。这里没有声称可测的正常路径 CPU 加速，测试使用虚拟时钟和本地函数 Mock，不代表真实模型质量或原生 MV3。

## Phase 2 — urgent cache opportunity and independent preparation

The old coordinator returned until candidate restoration completed or timed out at 250ms. A never-settling DB therefore delayed the current cue even when the physical Provider was idle. An additional 16ms opportunity now permits only low-water Fast work; farther Fast, Quality and summary preparation retain the ordinary 250ms policy. Existing source/batch validation and fully-covered-task cancellation are retained. Cache callbacks remain guarded by Session task identity, including 100 seeks/Stop/Start and late results. A partial one-member hit cannot cancel an uncovered multi-member request.

Lease acquisition and glossary loading now run concurrently after the config/provider snapshot is resolved. Both finish before enqueue; an abort is checked again. No model prewarming or Worker keepalive was added. The new deferred-lease test failed before the change and passes after it. `stage2-before.txt`, `stage2-preparation-before.txt` and `stage2-after.txt` retain red/green evidence (36 tests).

`BENCHMARK_KIND=cache node e2e/subtitle-harness/run.mjs SOURCE OUTPUT` ran 200 cases per revision in real Chromium, with real Coordinator/Session/renderer/resource scheduling and a **Mock** 100ms processor under a virtual clock. Baseline is exact `2d22b43b`; no paid API or real model quality measurement. P50/P95 are identical for each deterministic scenario:

| DB latency | hit      | old/new first visible and confirmed (ms) | old/new Mock starts per case |
| ---------- | -------- | ---------------------------------------- | ---------------------------- |
| 0          | no / yes | 101/101; 1/1                             | 3/3; 0/0                     |
| 8          | no / yes | 108/108; 8/8                             | 3/3; 0/0                     |
| 40         | no / yes | 140/116; 40/40                           | 3/4; 0/1                     |
| 300        | no / yes | 350/116; 300/116                         | 3/4; 2/3                     |
| hung       | either   | 350/116                                  | 3/4                          |

This is a latency/cost tradeoff, **not** a claim of fewer calls: urgent four-cue work can split the usual five-cue batches, and a 40ms cache hit can race one already-started request. No member is duplicated by the split; the partial-hit test protects useful outstanding members. Choosing zero wait would also race the 8ms warm cache; 16ms retains that hit while reducing hung-cache delay by 234ms. Server-side cancellation is not guaranteed. CPU for the complete 200-case run was 2.69→3.02 seconds; ending JS heap 78.5→90.7MB (not a peak or retained-leak claim; GC cadence differs). One additional short timer per pending read; Stop clears both timers, and every case reports zero post-Stop starts and one physical cache read. No token billing is represented by this harness. Cold-path HTTP/IPC and streaming measurements are recorded separately in subsequent phases.

## Phase 3 — opt-in streaming experiment

`stream-v1` uses the existing `consumeRemoteStream` / AI SDK, RequestQueue, BatchQueue, ResourceScheduler and per-member AttemptContext. `VITE_EXPERIMENTAL_SUBTITLE_STREAMING=true` is an explicit development build switch; **normal production builds remain non-streaming**. Export stays on complete responses. Unknown/custom prompt framing selects complete-response execution before dispatch. No Provider compatibility table or second limiter was added.

A versioned NDJSON protocol supplies explicit member IDs. The parser handles every chunk boundary (including one character at a time), multiple records, escaped newlines, missing/empty/out-of-order IDs, duplicates, overflow and malformed records. It caps total content at 65,536 UTF-16 units, each line at 8,192 and members at 32. Separate reasoning is ignored for display and counted against the response cap. Inline thinking and separator-only translation lines are rejected. A missing member cannot shift later IDs onto the wrong source cue.

Provisional events are scoped to live RequestQueue subscribers and shown through a small transient renderer map. They never enter the transcript, exports, candidate cache, or ready coverage. Coordinator task identity rejects late updates; cancellation and completion clear the transient map, preserving independently confirmed Fast/Quality. Successful explicit-ID results become the existing aligned batch cache. Missing positions use only the existing per-member fallback with inherited attempts. Protocol/ambiguous transport failure never triggers whole-batch non-streaming replay. The existing port handler is reused; ports have no heartbeat or reconnect. A dispatched stream retains its physical permit through iterator cleanup. One subscriber's cancellation preserves another subscriber's request.

`stage3-tests.txt`: 61 passing tests, including actual local HTTP + real AI SDK generate/stream + real queues + content translator across simulated message/port boundaries. Legal 5/8/12/20 batches each use one HTTP request. 429 uses two bounded attempts; mid-stream/early disconnect and duplicate IDs use one and cache nothing. Length completion with only member 0 uses five HTTP calls total (one batch plus the other four members), preserving the reliable first result. Partial Stop prevents further updates; simulated Worker death closes the port without replay; rebuilt Worker intake can recover once. Shared subscribers use one HTTP request; the permit remains active after first partial. Listener and scheduler balances return to zero.

Ten interleaved local HTTP runs per path, synthetic 5ms first-token/60ms remaining-output delay:

| Metric (ms)                      | complete response P50/P95 | experimental stream P50/P95 |
| -------------------------------- | ------------------------- | --------------------------- |
| first available display callback | 71.8 / 147.5              | 12.8 / 31.3                 |
| first confirmed result           | 71.8 / 147.5              | 74.4 / 90.6                 |
| complete batch                   | 71.8 / 147.5              | 74.4 / 90.6                 |

These are content-translator callback times, not browser paint times. Healthy coverage is 5/5 and HTTP starts 1/1. Input JSON bytes median 1896.5→1442 (different protocol instructions); output framing adds bytes. Returned usage is **synthetic** (100 input / 20 output, including 10 reasoning on streams), not real tokenization, prices, quality or cost parity. No currency saving is claimed. The 10-run tail includes first-load initialization; raw samples are retained in `stream-http.json`, including first-token timing, member counts, prompt bytes, interruptions and returned usage. Real model translation quality and vendor-specific stream behavior remain unverified; these are sufficient reasons to retain the stable default. Buffer/map bounds are explicit; no CPU/heap improvement is claimed for the experimental path. Native MV3 lifecycle remains a separate acceptance item.

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

## Phase 4 — bounded reasoning output and truncation

Red tests (`stage4-before.txt`) reproduced both unsafe behaviors: a length finish lacked a non-retryable classification, and unfinished `<think>` text was returned as translation. Shared `output-validation.ts` now makes length errors explicitly non-retryable and rejects unclosed inline reasoning. Both `aiTranslate` and `generateTextForProviderRef` retain this local error classification through their sanitizers. Closed inline reasoning is removed; independent reasoning channels never supply subtitle text. Stream length completion discards only an unfinished final JSON record; complete explicit-ID members remain aligned and cached, while valid-but-duplicate records still invalidate the batch.

`stage4-after.txt`: 35 tests pass, including real HTTP length completion. A non-streaming length result makes exactly one HTTP call (no whole-batch or individual fallback). A streamed batch with member 0 complete and the next record truncated uses five calls total, not repeated whole batches. All four missing members inherit their batch attempt. No unlimited budget, speculative extra retry, or default reasoning parameter change was introduced.

The extension's hard maximum remains 4096 output tokens; its subtitle estimate remains UTF-8 input bytes plus 64, scaled by 1.5 (segmentation 1.25), minimum 128. This cap is distinct from a Provider/model's actual context/output limit and the user's reasoning settings, which still flow through the existing `buildLocalGenerateTextParams`/Provider override logic. A Mock can demonstrate that reasoning spends a 128-token budget before a short final answer, but cannot establish a quality-equivalent replacement budget for real models. Defaults therefore remain unchanged. Returned reasoning usage in HTTP evidence is synthetic; it is not an observed real model billing comparison. Added validation is a linear pass over the returned text and allocates only tag matches; no CPU/heap speedup or quality parity is claimed. No change to the physical attempt maximum.

## Phase 5 — historical cache cost without a schema migration

The regression is reproducible with another new video's records: the former `below(current) OR above(current)` probe always reports possible history. `stage5-before.txt` contains the failing false-positive test. New track identities now use `subtitle-track-v3:<existing versioned SHA-256>`. All previous identities are lowercase hexadecimal, so the **existing** `trackKey` index proves historical absence with one bounded `.below("g").limit(1).count()`. This requires no schema upgrade, full-table scan, persistent flag, or additional playback writes.

Compatibility includes the exact previous versioned digest plus both safe older delimiter digests (maximum three keys). The previous digest is already computed, while the two large historical hashes stay lazy. Ambiguous delimiter inputs still exclude the old unsafe digests; the unambiguous prior version remains recoverable. Provider/account/language/context identities are unchanged. Mixed/new partial hits still read historical Quality, and each probe observes cross-tab old-script writes. Existing old records are neither removed nor rewritten. During a mixed-version rollout, historical records still incur compatibility work; this is intentional, not an immediate promise to make every existing DB cheap.

`stage5-after.txt`: 16 tests pass. Real Chromium IndexedDB over 2,000 other-video bundles and actual 50,000-cue / 3-hour identity, 20 samples:

| Case                             | P50 / P95 total (ms) | historical hash computations |
| -------------------------------- | -------------------- | ---------------------------- |
| 2d22 baseline, another new video | 289.0 / 315.0        | 20 sessions                  |
| prefixed new videos              | 115.9 / 119.2        | 0                            |
| actual historical records        | 304.2 / 327.4        | 20 sessions                  |

Probe median 1.0→0.85ms. Whole-run renderer CPU 6.89→3.42 seconds. No extra index/storage flag was added; the prefix adds 18 ASCII characters per new track key. The previous digest is retained in the bounded compatibility array. IPC remains one window read when history is absent; first historical window adds one read, as before. Historical recovery still pays full safe hash cost.

Complete-batch cache gets were measured separately in actual IndexedDB, 100 samples per condition: new hit P50/P95 0.2/0.3ms (100 gets), legacy hit 0.3/0.6ms (200), full miss 0.3/0.5ms (200). The additional lookup is approximately 0.1ms at median here. It does not justify a migration or a potentially stale absence flag: **batch-cache lookup remains unchanged**. No Provider starts/tokens, no translation quality or default Provider change. Raw data and the repeatable `history-cost` harness are retained. Database upgrade preservation is included in final Chromium resource acceptance.

## Phase 6 — explicit lease ownership and navigation cleanup

`stage6-before.txt` reproduces capacity exhaustion: lost navigation revocations eventually fill the unchanged 256-entry Map. A lease now opens inside a passive runtime-port handshake, so creation and ownership cannot be separated by a lost bind message. The Session keeps its existing lease Promise, finite restart recovery and Stop acknowledgement; only acquisition/connection ownership changes. Connection closure revokes its lease and removes those scopes through the existing shared queues. No timer, TTL, heartbeat, reconnect or automatic request replay was added. Closing an unanswered handshake rejects admission, allowing Stop to finish. Older content scripts retain the original RPC handler.

`webNavigation.onCommitted` also reclaims old document authority (including old child frames on main-document navigation); a current document's lease is preserved. Tab removal retains its existing cleanup. Other tabs and surviving shared subscribers continue. No active lease is revoked merely because it is old, paused or hidden. No capacity increase.

`stage6-after.txt`: 105 tests pass, including 500 failed Stop-RPC cycles, 500 lost navigation revocations, an 8-hour paused lease, no-response handshake Stop, active export isolation, first-partial cancellation, Worker replacement and 100 Stop/Start cycles. Passive-port and listener cleanup is exercised with real Session/runtime classes over simulated ports; actual local HTTP still verifies shared transmission and zero post-Stop starts.

Real Chromium runtime benchmark: 20 runs, each 500 navigation/revoke operations among 128 deliberately retained live leases. P50/P95 8.25/11.5ms per 500 operations (~0.017ms median per cleanup); renderer CPU 0.87s for the whole harness. All 128 live leases survive each run, and all are removed at explicit close. There is no periodic scanning cost. Each live connection adds bounded message/disconnect listeners and a closure; each lease adds frame/document ownership, with the existing maximum 256. Native MV3 port lifetime/Worker suspension is **not** established by these simulated tests; no keepalive messages are sent, and native acceptance remains required.

### Startup component measurements

`startup-http.json` contains optional preparation timing, actual RequestQueue/ResourceScheduler admission waits and HTTP first-token times. On the first 20 interleaved local runs, configuration snapshot read P50/P95 0.005/0.010ms, pure Provider resolution 0.021/0.083ms, lease handshake 0.147/0.318ms, glossary-disabled preparation 0.096/0.211ms. Lease/glossary spans overlap; they must not be added. Configuration is already supplied by the session, and these IPC ports are simulated, so these are **not Chrome cold-Worker IPC latency claims**. The `ipc` span (median 74.55ms) is the complete background roundtrip, including queue, HTTP and model delay; the raw queue/admission arrays separate their contributions. Real IndexedDB window probing is measured independently above (~0.85ms median); the urgent policy caps its startup opportunity at 16ms. Actual SDK HTTP first-token timings are retained per call; healthy local output delays are synthetic 5ms/60ms. No paid prewarming or forced Worker residency. Full browser startup also includes source/identity preparation (50,000-cue hash ~116ms), which is not hidden inside the HTTP benchmark.

Final review also covers a Provider-owned output cap: `finishReason=length` is rejected even when the caller omitted `maxOutputTokens`. An omitted extension cap does not make a Provider-truncated answer complete. The added regression verifies non-retryable classification; it does not add tokens or another request.

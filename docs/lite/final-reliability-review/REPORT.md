# 最后一轮定向可靠性验收

后续 0.2.7 发布验证：[CI 41285865314](https://github.com/poohyeban/read-frog/actions/runs/41285865314) 已通过 328 文件 / 2976 项测试和 4 项既有原生扩展受控回归。它不覆盖下方新增的流式、同 Session 500 次失败和自然 Worker 休眠项目；这些项目仍待原生验收。本文正文保留原定向审查时的证据口径。

基线：`codex/subtitle-engine-v2` 的 `875b9a1740b9a0dd7bc85515c35ff3cc249a79b8`。本轮开始时 fetch 后与本地 HEAD 差异为 0/0，工作区干净。先检查实现、添加测试并实际运行失败，再修改生产代码。所有 HTTP 均为 `127.0.0.1` 本地服务；未调用真实免费/付费翻译 API，未推送、创建 PR、触发 Actions 或发布 Release。

## 结果与请求次数

| 检查                             | 修复前证据                                                                               | 最终行为与请求数                                                                                                                            | 质量不变式                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| P0：重复文本 provisional         | 正序、乱序、单成员 fallback 都把第 0 个成员的临时译文发到第 1 个位置；两个模拟标签均复现 | 两条同文本、不同时间位置、不同译文，正序与乱序各只用 **1 HTTP**，两个标签共享                                                               | 按原始 cue 位置接收；原文及时间戳不变；最终译文与 provisional 对应                             |
| P0：fallback 与共享              | 仅改变去重身份会使不同批次的相同 singleton 请求由 3 变 4，专门测试捕获了这一退化         | 首位缺失、末位缺失、两个重复成员都缺失，各 **2 HTTP**；不同批次共享相同缺失成员共 **3 HTTP**（两批＋一 singleton）                          | 路由身份与请求去重身份分离；不会把 fallback 写到已完成的同文本邻居；原尝试预算与跨标签共享保留 |
| P1：同实例 500 次失败 Stop/Start | **125,250** 次 revoke RPC，保留 **500** 个旧 Promise                                     | **500** 次 revoke RPC，每个租约一次；重复 Stop/Dispose 不追加 RPC；模型 HTTP 为 **0**                                                       | 每次 Stop 仍向调用者报告确认失败；任务 abort、旧租约失效；新租约能独立 Stop                    |
| P1：HTTP 已开始但零 delta 断流   | 已收到请求体、发出 200 SSE 响应头后断开，不发送任何 reasoning/text；仍发 **3 HTTP**      | 断流仅 **1 HTTP**，无 provisional、无缓存、无自动重放；独立 429→成功对照仍 **2 HTTP**                                                       | 不把“没看到 token”当成“请求没发送”；SDK 内部重试仍为 0，总额度不扩大                           |
| 截断部分缓存                     | 首尾空位置被整串 trim 破坏；第二次运行多发 **1** 整批 HTTP；首空、尾空、两端空测试失败   | 第一次 **5 HTTP**（一批＋四个缺失成员）；第二次 **0 HTTP**，累计 **6→5**                                                                    | 完整显式 ID 成员保留，未闭合 JSON 不进入缓存；空位置不移位；恢复结果与首次完全一致             |
| 长期挂起的缓存读取               | 未发现需修改的缺陷；补充恢复测试在基线上已经通过                                         | 永久挂起并经历 100 次 Seek/Stop/Start，始终只启动 **1** 次缓存读取；八小时旧读取跨重启后返回，再启动 **1** 次新读取，恢复测试模型调用 **0** | 旧结果不发布，后续有效结果可恢复；期限到达只结束播放等待，不伪称物理读取已取消                 |

初始失败记录：[主要问题](evidence/red.txt)、[缓存边界](evidence/cache-red.txt)。不同批次共享的退化对照：[失败](evidence/shared-fallback-red.txt)、[最终通过](evidence/shared-fallback-green.txt)。最终专项：[12 个文件、141 个测试](evidence/targeted.txt)。

## 修复位置与边界

- [translation-plan.ts](../../../src/utils/subtitles/translation-plan.ts)、[translator.ts](../../../src/utils/subtitles/processor/translator.ts)、[后台入队](../../../src/entrypoints/background/subtitles-translation.ts)：仅为流式成员计算由有序批次与原始索引确定的 `streamMemberKey`。原 `hash`、持久缓存身份和 AttemptContext 成员身份不变。Provider、凭据、模型、目标语言、上下文变化仍隔离；同批次不同标签的路由身份一致。
- [stream updates](../../../src/entrypoints/background/subtitle-stream-updates.ts)、[translation queues](../../../src/entrypoints/background/translation-queues.ts)：共享 singleton 仍按原语义 Key 入队；已有订阅中保存临时的“singleton→本订阅缺失位置”映射，按现有 live scopes 发送。映射在 `finally` 清理，断开订阅直接释放其映射；不保存历史结果、不加定时器。测试为不同批次的共享 singleton 设置明确屏障，确认两个订阅都已进入 fallback 后才发送帧，不依赖服务器恰好慢一点。
- [session.ts](../../../src/utils/subtitles/session.ts)：移除失败撤销 Set，保留当前 Stop 确认 Promise。被动连接关闭负责回收授权；RPC 是确认路径。失败的 Stop 不伪装成成功，也不因后续 Stop 重发所有旧 RPC。连续 Stop 返回同一确认结果；新租约创建新的确认。既有“第二次 Stop 重试旧 RPC”测试相应改为“保留失败结果、无重放、新租约可停止”。断连、未完成握手、长暂停、独立导出和 Worker 重建回归仍通过。
- [remote-executor.ts](../../../src/utils/providers/remote-executor.ts)：在现有 permit 的 `start()` 成功后记录实际 dispatch；同一流无论通过错误帧还是迭代器 reject 失败，都不能在已发送且无明确安全 HTTP 拒绝时重试。保留显式 429/503 分支，已有任何 text/reasoning delta 后仍禁止重放；实际 HTTP 对照覆盖 429。
- [parseBatchResult](../../../src/entrypoints/background/translation-queues.ts)：先按分隔符拆分，再 trim 各成员，保留编码首尾空位所需的换行。缓存 Key、schema、数据均保留，不清库。长期挂起读取仅加回归测试，未改 Coordinator、IndexedDB 调度或恢复策略。

ResourceScheduler、RequestQueue、BatchQueue、AttemptContext 与双通道架构均未修改；Session 仅修复撤销状态。没有新增物理限速器，没有提高 API 尝试额度，流式仍默认关闭。

## 资源余额和证据口径

最终本地 HTTP 专项共 **66 次**受控 HTTP 开始：既有对照 47 次，本轮新增场景 19 次。每个场景都核对服务端次数与物理 Scheduler 的 starts 相等。九个场景收尾均为 **active=0、queued=0、timers=0、leases=0、tasks=0、portListeners=0、fallbackRoutes=0**。

逐场景证据：[正序](evidence/http.json.same-text-ordered.json)、[乱序](evidence/http.json.same-text-unordered.json)、[末位 fallback](evidence/http.json.same-text-fallback.json)、[首位 fallback](evidence/http.json.same-text-fallback-first.json)、[两个缺失成员共享 fallback](evidence/http.json.same-text-all-fallback.json)、[不同批次共享 fallback](evidence/http.json.shared-fallback.json)、[零 delta 与 429](evidence/http.json.zero-delta.json)、[截断缓存](evidence/http.json.partial-cache.json)、[原有 HTTP 对照](evidence/http.json)。

同实例 500 次 RPC 失败测试每轮均断言租约和任务为 0、旧租约无法重新授权，结束时所有端口监听器为 0，旧 revocations 集合保留量为 0。证明的是保留状态与请求次数有界，不是一次真实浏览器堆快照或精确内存字节测量。

永不返回的缓存测试在 Stop 后仍有 **1 个未结算 read Promise**；这是实际未完成读取，不能报成物理资源 0。它不产生新的读取、模型任务或定时器；任务与定时器余额为 0。八小时后返回的恢复对照最终两次读取均结算，任务与定时器为 0。这些是受控 Promise 的故障注入，不是人为挂死原生 IndexedDB 进程。

重复原文场景记录 `textOccurrences`，不把同文本累计次数冒充单个 cue 的尝试次数；两个订阅的重叠计时样本也不相加为 HTTP 总数。usage 是合成值，不用于声称真实费用或模型质量。

## 完整检查

- 专项回归：12 文件、141 测试通过。
- 完整 Vitest：**328 文件、2976 测试通过**，见 [vitest-full.txt](evidence/vitest-full.txt)。始终设置 `SKIP_FREE_API=true`，跳过依赖外部服务的免费 API 测试。
- 类型检查与 Oxlint：[仓库统一命令](evidence/typecheck-oxlint.txt) `oxlint --type-aware --type-check`，退出 0。
- 格式检查：[format.txt](evidence/format.txt)，`oxfmt --check .`，通过。
- Chrome MV3 生产构建：[build-mv3.txt](evidence/build-mv3.txt)，通过；7.717s、14.95MB。保留已有 locale、chunk 和动静态导入提示。

专项由实际 AI SDK、本地 HTTP、生产翻译函数与现有队列执行；IPC、端口、存储边界受控模拟。此前 165 场景矩阵报告保留历史口径，本轮没有重跑该矩阵，不把旧结果列为本轮新验收。

## 未验证风险与原生 MV3 待验收

未验证真实 Provider 的 NDJSON 遵循率、翻译质量、Token 费用与所有 SDK/厂商异常形态。零增量测试覆盖本地 OpenAI-compatible 服务在收到请求后发送 200 响应头并断流；不是所有网络设备和厂商的穷举。停止后的服务器计费无法由客户端 abort 保证。RPC 持续失败测试覆盖持续 reject，不证明任意永不 settle 的消息实现不会留下等待者。

当前 `/etc/chromium/policies/managed/extensions.json` 仍为 `ExtensionInstallBlocklist=["*"]`；没有绕过策略。本轮 **原生扩展验收未执行**，生产构建通过也不能代替它。沿用[原生 MV3 清单](../subtitle-streaming/NATIVE-MV3-CHECKLIST.md)，追加本轮必须完成的项目：

- [ ] 两个真实标签播放重复文本字幕，交错、乱序返回不同译文；分别让首位、末位或两者进入共享 fallback，核对画面 cue 和请求数。
- [ ] 同一个实际 Session 做 500 次 Stop/Start，持续丢失 revoke RPC；观察 Worker、端口、租约、堆快照和旧任务是否回收，同时保留另一个标签与独立导出。
- [ ] 真实 Worker 自然休眠/重启、页面/iframe 导航、流中 Stop；确认不自动重放已发送请求，下一次新任务能重新申请租约。
- [ ] 原生浏览器本地 HTTP 零 delta 断流与 429 对照，真实 IndexedDB 长阻塞后恢复及截断缓存二次读取；确认默认生产构建仍使用非流式路径。

## 复现命令

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/oxfmt --check .
node_modules/.bin/wxt build -b chrome
SKIP_FREE_API=true SUBTITLE_STREAM_METRICS=/tmp/subtitle-review-http.json node_modules/.bin/vitest run src/entrypoints/background/__tests__/subtitle-stream-http.test.ts
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/subtitles/__tests__/lease-connection.test.ts src/entrypoints/background/__tests__/translation-queues.test.ts src/entrypoints/subtitles.content/__tests__/cache-restoration.test.ts
```

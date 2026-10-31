# Read Frog Lite：共享资源调度与双通道字幕本地验收

> `d7e4e8b` 之后的针对性收敛、最终检查及重复测量见 [CONVERGENCE.md](CONVERGENCE.md)。本页保留上一轮历史验收口径。

日期：2026-10-31。基线：`fddc448e72cca5aa3007fcf27ab15c378288c844`。所有开发、提交、测试和构建均在本地工作区完成；没有推送、创建 PR、触发 GitHub Actions 或发布 Release。所有性能 Provider 均为 Mock，没有使用真实付费 Token。

## 已完成的行为

- 删除全局/字幕/导出累计费用、请求及 Token 预算。移除旧 `hardBlocked`、设置、失效测试及账本表；保留历史迁移定义用于安全升级。诊断计数不参与请求准入。
- `ResourceScheduler` 成为物理并发、速率、突发与 429 冷却的唯一执行权威。`RequestQueue` 保留逻辑任务、去重、取消及有限重试；`BatchQueue` 保留有界聚合与格式错误恢复。多资源约束一次全部获取，中心化优先级/老化调度，队列与定时器有界。
- 按 Provider/账户及手动资源组统一限制。别名共享物理账户；认证改变后新身份不继承旧手动组。安装级 HMAC 主记录与恢复记录持久化，名称不参与身份；凭据、HMAC 与组成员身份不进入便携配置导出。
- 普通生成、消费流式生成、外部音频生成/转录统一接入受保护入口。SDK 重试为 0。AST 架构检查与真实 SDK + Mock transport 测试防止绕过。本地音频播放、缓存、字幕渲染不占远程许可。
- Defaults + Sparse Overrides 配置独立存储。高级设置默认折叠，数值草稿 blur/Enter 后才提交，后台串行合并字段修改；仅明确修改产生覆盖。支持节级恢复默认与完整重置。迁移保留旧 `maxInFlight`、非默认队列值和诊断开关。
- Quality 合并行采用完整原文/译文对，不要求与 Fast 相同边界，不重复展示覆盖内容。保留搜索、定位、虚拟列表和滚动锚点。缓存行、来源跨度和投影，避免 timeupdate 重建全表。
- 缓存恢复、显示择优与 Provider 准入分离。Provider 不可用时历史有效 Quality 仍可恢复；回放重新选择 Quality > Fast > Original。
- 来源块/输出变体 manifest 验证完整 Quality；完整有效缓存不重复 AI 分段，部分或失效缓存不阻止必要处理。来源、字幕轨、翻译配置和 Provider 语义改变会隔离缓存。
- 保留双时间轴、自适应连续缓冲、单并发 Fast 优先准备、独立窗口、后台投机控制和有限预读。AI 分段不再阻塞 Fast 首句。
- 完整 SRT 保留显式启动、估算确认、独立生命周期、取消、逐块处理及完整性校验；翻译失败不会生成伪完整文件。

本地代码分阶段提交见 [revision.json](evidence/revision.json)，构建产物的 manifest SHA-256 也记录在该文件中。新增远程入口的架构门禁复验见 [architecture.log](evidence/architecture.log)。

实现说明见 [IMPLEMENTATION.md](IMPLEMENTATION.md)，全部量化对比见 [METRICS.md](METRICS.md) 与 [summary.json](evidence/summary.json)。

## 验收结果与证据

| 检查                                | 结果                                                                                                    | 证据                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全量 Vitest                         | 316 个文件、2841 项通过；实时免费 API 测试按 AGENTS.md 设置 `SKIP_FREE_API=true`                        | [tests.log](evidence/tests.log)                                                                                                                                                                                                                                                                     |
| 类型检查与 Lint                     | `oxlint --type-aware --type-check` 通过；项目的 type-check/lint 使用该命令                              | [lint-typecheck.log](evidence/lint-typecheck.log)                                                                                                                                                                                                                                                   |
| 格式检查                            | `oxfmt --check .` 通过                                                                                  | [format.log](evidence/format.log)                                                                                                                                                                                                                                                                   |
| WXT 本地生产构建                    | `wxt build` 成功，输出 `.output/chrome-mv3`，约 14.92 MB                                                | [build.log](evidence/build.log)                                                                                                                                                                                                                                                                     |
| Chromium 双通道/资源矩阵            | 165 场景，1x/2x/4x，1/2/4/8 并发，100 ms 至 30 s Provider，正常/4 倍密度、429/408/401、缓存与调参       | [matrix-current.json](evidence/matrix-current.json)                                                                                                                                                                                                                                                 |
| 100 次随机 Seek + 100 次 stop/start | 3 小时字幕、4x；所有边界断言通过；停止后新请求 0，收尾 active/queued/timers 均 0                        | [lifecycle.json](evidence/lifecycle.json)                                                                                                                                                                                                                                                           |
| 100 次用户开关                      | 真实 Adapter/Coordinator 集成测试；已完成字幕保留，100 次停止确认均完成，源轨只获取一次，译文只生成一次 | [`universal-adapter.test.ts`](../../../src/entrypoints/subtitles.content/__tests__/universal-adapter.test.ts)                                                                                                                                                                                       |
| 100 次后台撤销与 Worker 重启        | 撤销确认后实际 Provider 开始次数严格为 0；独立导出仍可执行；旧 Worker 租约失效                          | [resource-migration.json](evidence/resource-migration.json)                                                                                                                                                                                                                                         |
| 三项字幕缺陷                        | 独立边界 Quality 配对、无 Provider 的历史缓存、完整/部分/无效来源块恢复专项回归均通过                   | [`transcript.test.ts`](../../../src/utils/subtitles/__tests__/transcript.test.ts)、[`dual-lane.test.ts`](../../../src/entrypoints/subtitles.content/__tests__/dual-lane.test.ts)、[`quality-restoration.test.ts`](../../../src/entrypoints/subtitles.content/__tests__/quality-restoration.test.ts) |
| 侧栏浏览器回归                      | 50,000 行虚拟列表、定位、手动滚动、倒退、Quality 合并后源时间/像素锚点共 10 项通过                      | [functional.json](evidence/functional.json)                                                                                                                                                                                                                                                         |
| IndexedDB v5 → v7                   | 真实浏览器保留翻译、词汇表和分段缓存，删除两张旧账本表，并升级区间索引                                  | [resource-migration.json](evidence/resource-migration.json)                                                                                                                                                                                                                                         |
| 完整 SRT                            | 100/1,000/10,000/50,000 条，各 3 次，完整、无重复；3 小时分块/中途取消/失败另有单测                     | [export-current.json](evidence/export-current.json)                                                                                                                                                                                                                                                 |
| 网页翻译 Mock E2E                   | 冷/热 × 智能上下文开/关 × 3 次；浮动布局、Markdown、Shadow DOM、巨型段落、SPA、虚拟列表及突变兼容通过   | [web.json](evidence/web.json)、[web-e2e.log](evidence/web-e2e.log)                                                                                                                                                                                                                                  |
| Popup / 设置 / 翻译中心             | Popup 交互全部通过；设置和翻译中心各 3 次；资源设置默认折叠、读取不写入已在生产构建页面验证             | [popup.json](evidence/popup.json)、[settings-pages.json](evidence/settings-pages.json)                                                                                                                                                                                                              |
| 划词、输入框、网页现有业务          | 完整测试覆盖输入框、Lexical、划词取消/重新请求、流式生成及页面翻译；共享 SDK Mock 验证通过              | 全量测试日志与对应业务测试                                                                                                                                                                                                                                                                          |

`SKIP_FREE_API=true` 是仓库明确要求的本地测试方式。构建仍有非致命的 az locale、较大 chunk 和 en locale 静态/动态混合导入提示，未将这些提示隐藏或记作失败。

## 尝试次数、取消与安全边界

`maxAttempts` 包含首次实际 Provider 调用，并按原始成员守恒。一次 N 成员物理批次格式失败后，拆分恢复的上界为 `1 + N*(R-1)`；默认 R=3、N=5 的实际调用上界为 11。若逻辑窗口本来就分成 B 个物理批次，则上界为 `B + sum(R_i-1)`，不超过 `sum(R_i)`。批次、请求队列、SDK 与业务层不能各自重试叠加。

401/403 与永久错误不拆批；429 共享 Retry-After/冷却；超时和临时错误有限重试；只有格式/数量错误触发拆分。测试覆盖实际调用计数、取消后回退、并发降低、动态策略、跨业务/标签订阅去重、组迁移、令牌不被配置变更补满、普通任务老化与紧急任务提升。

关闭播放立即阻止调度，后台撤销租约后才报告停止完成。派发前再次校验租约与当前认证修订。已发出且忽略 Abort 的远端工作可能继续；客户端许可保持到可确认结束，不发布失效结果或自动重复派发。Worker 崩溃后的远端服务执行不可由扩展控制，不能声称跨崩溃仍可严格限制服务端实际并发。流式许可保持到迭代器结束或取消完成。

当前 Provider 适配器没有可验证的 OAuth 账户主体，因此不会从未验证 JWT 或任意 Header 猜测账户。身份模块支持可信适配器提供 issuer/subject；已验证主体的短期 Token 刷新保持身份，无法验证时保守隔离。双份身份根均不可恢复时明确失败，不静默重建已有组绑定。

## 性能结论的适用范围

最终矩阵逐场景显式销毁共享会话，区别于开发中保留会话的诊断运行；报告只使用最终成对数据。播放时间是虚拟时间，CPU/主线程耗时/内存是实际 Chromium 测量。时间轴与侧栏各有 30 个样本；SRT 仅 3 个样本。Mock 不代表真实服务商的网络、计费或模型质量。

整体请求数没有全面下降：更充分的单并发 Fast 缓冲和独立 Quality 窗口会执行部分旧版未完成的工作。报告同时给出请求、估算 Token、取消、重试、缓存恢复、就绪率和资源拒绝，避免仅挑选有利数字。完整历史 Quality 的重复分段、重复翻译由专项回归确保消除。所有累计消费限制均已删除，持续播放仍会按需要请求；消费额度由用户的 Provider 管理。

所有已测场景停止后新请求和并发越界均为 0。慢 Provider、单并发被远端长任务占据或 4x 高密度吞吐不足时，调度无法保证每句译文按时到达；显示仍可使用历史缓存和原文。

原生 MV3 E2E 未通过验收：当前管理策略 `ExtensionInstallBlocklist=["*"]` 禁止安装扩展。未修改策略、未绕过限制。已执行真实 Chromium DOM/IndexedDB/生产页面的 Mock E2E，不能把它描述为真实扩展 Service Worker 多标签端到端验收。具体环境证据见 [mv3-preflight.json](evidence/mv3-preflight.json)。

## 本地复现

```sh
SKIP_FREE_API=true ./node_modules/.bin/vitest run
./node_modules/.bin/oxlint --type-aware --type-check
./node_modules/.bin/oxfmt --check .
./node_modules/.bin/wxt build
PERF_RUNS=3 ./node_modules/.bin/playwright test e2e/translation-performance.spec.mjs
node e2e/ui-harness/prepare.mjs
node e2e/ui-harness/functional.mjs .output/chrome-mv3 /tmp/read-frog-popup
UI_SAMPLES=3 node e2e/ui-harness/pages.mjs .output/chrome-mv3 /tmp/read-frog-pages
BENCHMARK_KIND=matrix node e2e/subtitle-harness/run.mjs /workspace/read-frog /tmp/read-frog-matrix
BENCHMARK_KIND=lifecycle node e2e/subtitle-harness/run.mjs /workspace/read-frog /tmp/read-frog-lifecycle
BENCHMARK_KIND=resource node e2e/subtitle-harness/run.mjs /workspace/read-frog /tmp/read-frog-resource
BENCHMARK_KIND=functional node e2e/subtitle-harness/run.mjs /workspace/read-frog /tmp/read-frog-functional
BENCHMARK_KIND=timeline node e2e/subtitle-harness/run.mjs /workspace/read-frog /tmp/read-frog-timeline
BENCHMARK_KIND=transcript node e2e/subtitle-harness/run.mjs /workspace/read-frog /tmp/read-frog-transcript
BENCHMARK_KIND=export node e2e/subtitle-harness/run.mjs /workspace/read-frog /tmp/read-frog-export
python e2e/subtitle-harness/resource-report.py
```

对比时把 source 参数换为隔离的基线 checkout，使用同一个 harness。矩阵随机退避使用固定种子，Provider 无网络依赖。`BENCHMARK_PROFILE=1` 可生成 CPU profile。旧的 RequestQueue 独立限速基准已移除，以物理资源矩阵替代，避免继续用失效的队列配置作结论。

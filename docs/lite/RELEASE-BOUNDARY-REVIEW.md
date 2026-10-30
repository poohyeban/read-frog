# 字幕架构最终边界修复与发布前验收

基线：`codex/subtitle-session-upgrade` 的 `27297cdaedc6b63e1dc1e3ea7236afb6996c8ac0`。日期：2026-10-30。仅修复缓存身份、回退取消与 Popup 确认边界；保留现有 Session、调度、区间索引、虚拟列表、并发上限、完整导出及 Provider 架构。

**源码修复和可执行回归已完成；真实 MV3 发布验收尚未通过。** 当前环境的管理策略禁止加载 unpacked 扩展，未绕过策略。真实 YouTube / Netflix / X.com、真实 Popup 窗口、自然 Service Worker 休眠/唤醒和重新加载仍需在允许的环境执行 [人工验收清单](MV3-MANUAL-ACCEPTANCE.md)。

## 已确认缺陷与最小修复

| 问题                          | 源码确认                                                                                                                                                                                                                    | 修复与针对性回归                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 批量结果污染单条字幕缓存      | `createSubtitleTranslationPlan()` 只渲染单条文本和自身术语；`executeBatchTranslation()` 实际发送有序多条文本及 `mergeBatchGlossaryTerms()` 的并集；消息处理器却把拆分结果写入每条 hash。A+B 的 A 可被 A+C 或 A 单项错误复用 | LLM 字幕不再读取/写入旧单条持久缓存。实际执行边界以 provider 配置、语言、有序输入和最终 system/user Prompt 生成独立缓存键，保存并校验整批结果；回退走同一个函数的单项路径 |
| pending 去重越过术语 revision | 批次 key 有 revision，`getDedupKey` 只有单条 hash；本条命中术语不变时，可在进入批次前误加入旧 revision 的邻居组                                                                                                             | 字幕 pending 去重加入 glossary revision。测试同一 A 分别与旧 revision 的 B、新 revision 的 C 入队，必须得到各自上下文的结果                                               |
| 单项回退丢失共享订阅者        | BatchQueue 收集了多个 scope，但回退只把首个 `data.scope` 交给 RequestQueue；首个订阅者取消可中止仍被另一个播放/导出任务需要的请求                                                                                           | 回退传递每项全部仍有效的 scopes；无 scope 的订阅者继续保持 pin 语义。真实队列测试在回退进行中取消首个订阅者，另一个仍能取得结果                                           |
| Popup 重试沿用旧 URL          | `refresh()` 仅在首次 query 时保存 tab，此后直接用旧 URL 读取                                                                                                                                                                | 重试通过 `tabs.get(原 tab ID)` 取得最新 URL；监听 URL、loading/complete 和关闭；命令发送前再次核对。切换活动标签或原标签关闭时不会转移操作目标                            |
| 并发读取取消写入确认          | 后台每个 request 都创建并删除 revision，包括只读请求                                                                                                                                                                        | 读取共享当前代次，只有写入及导航失效能淘汰旧请求。新写入仍使较早的读取失效；同 URL 重载、旧回执、两个 Popup 和多个读取与一次停止并发均有测试                              |

`mergeBatchGlossaryTerms()` 的现有版本选择、相同版本冲突剔除、稳定排序规则保留。缓存现在记录这些规则产生的**实际 Prompt**，即使并集与本条术语不同，也不会用本条的 hash 冒充该 Prompt 的身份。未关闭批处理、减少上下文或删除术语功能。

## 缓存约束与取舍

- `SubtitleTranslationPlan.request.hash` 是单条请求快照验证与准入去重身份，不再代表批量 LLM 的持久缓存身份。视频位置、会话和优先级仍不属于语义缓存键。
- 新持久命名空间是 `subtitle-batch-prompt-v1`。批次成员、顺序、边界、有效 Prompt、上下文、术语或 Provider 改变时重新取结果；重复完全相同的批次可命中。批量缓存按原顺序拆分，不拼接来自其他批次的单条记录。
- fallback `[A]` 与正常单元素批次 `[A]` 的实际 Prompt 相同，可以共享；它与 `[A,B]` 不共享。错误条数、非空原文的空译文、已取消模型请求不写成功缓存。条数错误仍由 BatchQueue 有限重试，不额外消耗一次 RequestQueue 条数重试预算。
- 保留旧缓存数据等待已有清理机制处理，但 LLM 字幕不再读取旧单条键。无需删库、清空全部缓存或变更 IndexedDB schema。
- 缓存查找在批次形成后的 RequestQueue 执行阶段，因此命中仍可能经历聚合和队列等待，并占用该队列的调度配额，但不调用模型。批次划分变化会减少跨批次复用；本轮优先保证结果属于真实请求语义，不宣称保持原错误复用的命中率或延迟。
- 多 scope 批次中只要仍有有效订阅者，就允许完整请求继续并按完整语义缓存；已退出的订阅者仍在消息处理器的 scope 校验处拒收，不发布到旧页面。

## 测试证据

Node v24.19.0、Chromium 154.0.8037.57。测试运行设置 `SKIP_FREE_API=true`；AGENTS 指定的旧 live free-api 测试文件在此版本不存在，没有把外部付费服务当作可用回归。

| 检查                     | 结果                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 修复前定向回归           | 3 文件，7 失败、15 通过；记录见 [before.txt](release-boundary/before.txt)                                                            |
| 修复后完整 Vitest        | **300 文件、2781 测试通过**，109.97 秒；见 [tests.txt](release-boundary/tests.txt)                                                   |
| 类型与静态检查           | `oxlint --type-aware --type-check` 通过；仓库 `lint` 和 `type-check` 脚本相同，执行一次完整命令覆盖两者                              |
| 格式与补丁空白           | `oxfmt --check .`、`git diff --check` 通过；见 [验证记录](release-boundary/verification.json)                                        |
| WXT 生产构建             | 通过，9.827 秒，Chrome MV3 产物 14.82 MB；见 [build.txt](release-boundary/build.txt)                                                 |
| 生产 Popup 浏览器夹具    | 13 项交互通过，0 pageerror；extension API 受控，非原生 Popup 验收                                                                    |
| Transcript 浏览器夹具    | 8 项功能通过，0 pageerror                                                                                                            |
| 字幕恢复/Seek 浏览器夹具 | 12 场景 × 30 次；360 次全部发布覆盖目标时间的字幕，停止后发布数为 0；包含 35:20 异步恢复和长 cue                                     |
| 实际队列工厂浏览器夹具   | 3 场景 × 30 次：有界导出、当前播放优先、取消执行中请求；0 pageerror；Provider 为 20 ms mock                                          |
| 完整 SRT 浏览器夹具      | 100 / 1000 / 10000 / 50000 条，各 3 次；全部数量、唯一性及时间轴有效；真实 downloader/SRT 构造器，翻译和磁盘下载受控                 |
| 网页翻译浏览器回归       | `playwright test e2e/translation-performance.spec.mjs` 通过；5 轮 × 2 上下文配置 × 冷暖场景，另含 DOM 特殊场景；受控传输，不证明 MV3 |
| 原生 MV3 预检            | **blocked-by-policy**，退出码 2；[只读策略证据](release-boundary/mv3-preflight.json)。未尝试绕过安装限制                             |

浏览器结果见 [browser-evidence.json](release-boundary/browser-evidence.json)，包含逐次字幕目标覆盖与停止后发布检查、队列样本数、导出完整性和 UI 检查。完整轨迹可用仓库内 `e2e/subtitle-harness/run.mjs`、`e2e/ui-harness/functional.mjs` 和 Playwright 测试重新生成。

新增回归覆盖批次术语并集、邻居/顺序/边界变化、重复批次命中、回退缓存隔离、旧缓存旁路、错误缓存条数、不同术语 revision 的 pending 去重、回退共享取消、Popup 导航后重试、同 URL 重载、关闭目标标签、另一个活动标签、旧回执及两个 Popup 与读写并发。完整测试保留之前的 35:20 恢复、长 cue、广告、轨切换、倍速、导出及会话生命周期覆盖。

日志中的 jsdom 文档导航提示、AI SDK response-format 兼容警告没有导致失败。浏览器回归并行运行，时间/内存样本只作为本次功能诊断，不用于声称性能提升。

## 未验证项与可复现交付

`e2e/mv3-preflight.mjs` 只读检查已知策略；阻断时不加载扩展。允许的环境中可以验证目标扩展实际 Worker，但成功也只标为 `available-not-accepted`。既有 `e2e/subtitles.spec.mjs` 保留真实扩展通路，补入准确的 35:00–35:40 长 cue、00:00 延迟恢复到 35:20，并使用多项批处理；本轮因策略限制未执行此原生夹具。

[人工清单](MV3-MANUAL-ACCEPTANCE.md) 覆盖全部要求，包括真实平台、广告/轨道、并行播放与 SRT、自然 Worker 休眠、唤醒及扩展重新加载。所有未实际执行的项目明确标记未验证，不能据此宣布可发布。

## 本地阶段提交

1. `73529d91` — `fix(subtitles): isolate batch cache and fallback scopes [skip ci]`
2. `f08411e9` — `fix(popup): recover navigation without cancelling writes [skip ci]`
3. 验收夹具、阻断证据和本报告：独立本地验收提交（见 `git log`）。

本轮未推送、未创建 PR/标签/Release、未合并 main，未修改或调用 GitHub Actions。没有新增依赖、扩展权限或全面架构重构。

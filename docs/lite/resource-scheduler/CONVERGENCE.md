# d7e4e8b 针对性收敛验收

本轮代码基线为 `d7e4e8bffaacc96cb6bed371aa230032e58503fa`，实现提交为 `ca2948b0`。只在本地提交、测试和构建。没有推送、PR、Actions 或 Release。ResourceScheduler 核心算法、实际许可入口、数据库 schema 与历史升级链未改动；没有恢复累计消费或美元计费逻辑。

## 1. Provider 身份解析竞态（P0）

**根因**：旧 `refresh()` 的循环保留旧 Provider 对象，却在跨越 HMAC/持久化的 `await` 后读取全局 `revisions`，可能把旧凭据身份登记为新凭据修订。等待方只等待一次 `updates`，也可能漏掉此后排入的更新。Resolver 自身没有发布序号，较早 HMAC 的迟到结果能覆盖较新映射；初始化等待期间读取调用者可变的认证材料也会串用配置。

**修复**：`src/utils/providers/resource-runtime.ts` 为每轮深拷贝、冻结 Provider，并同步生成局部修订 Map。使用 generation 丢弃过期轮次，完整解析后一起发布身份与身份修订；等待方跟随当前更新链，并拿到同一次发布的快照。真正发送前继续验证当前凭据与已发布身份修订。`src/utils/request/resource-identity.ts` 在首次 await 前序列化认证材料，以每 Provider 的请求序号控制发布，删除 Provider 同时使待完成发布失效。

**证据**：原代码确定性复现 4 个失败，见 `convergence-evidence/identity-before.txt`。新测试覆盖两个 Provider 同时快速改 Key、延迟 HMAC/持久化、等待期间切换手动组、旧账号别名留在新手动组、新 Key 保持独立默认策略，以及初始化期间修改输入。新的别名再次解析同一最终凭据，验证身份不是被错误贴上修订号的旧缓存。直接 Resolver 测试还验证迟到结果与 remove 后结果不能覆盖/复活映射。

## 2. 批次部分成功恢复（P1）

**根因**：数量正确但包含空译文时，字幕执行器抛出普通错误，使 RequestQueue 可能重发整个批次；BatchQueue 对数量正确的结果又缺少逐成员校验，最终可能丢失成功成员或把非法成员当成功。

**修复**：`src/utils/request/batch-queue.ts` 增加按原始成员验证结果的回调。数量一致时立即交付可靠成功项，仅失败项继承同一 AttemptContext 的 subset 进入单条恢复；恢复结果仍须有效，不能因格式异常重新生成无限批次。`src/entrypoints/background/translation-queues.ts` 保留有可靠位置的原始批次响应与输入来源，空位置交给 BatchQueue 恢复，数量不一致或全空响应不保存。后续命中部分缓存只补缺失成员，已成功成员不会再请求。

**实际调用上界**：首次物理批次之后若有 F 个失败成员，每成员总上限 R 含首次调用，则额外恢复不超过 `F × (R−1)`，总数不超过 `1 + F × (R−1)`；若该批次先前已有 k 次实际尝试，则为 `k + F × (R−k)`。权限错误、429、超时、永久错误的既有分类不变，均不能触发无差别拆分。

**证据**：原代码 3 项定向失败，见 `convergence-evidence/partial-before.txt`。真实 RequestQueue + ResourceScheduler 的 Mock 测试中，5 个成员、2 个失败、R=3，成员次数为 `[1,3,1,3,1]`，物理开始次数严格为 5，结束后 active=0；空的单条恢复明确失败。真实字幕队列工厂只调用一次批次与一次失败成员恢复，再次提交命中缓存，总调用仍为 2。401/403 仅 1 次，429/408/503 最多 3 次，均不拆分。

**无需补丁的检查**：`subtitle-candidates.ts` 原本按精确批次输入、成员索引、译文及词汇表修订验证候选，并不要求同一批次其他位置全部有效。新增确定性测试证明成功位置可恢复、空位置被拒绝、数量错位被拒绝，因此没有修改候选验证器或新增数据库字段。

## 3. 无界缓存恢复等待（P1）

**根因**：`restoreCandidates()` 在同一窗口存在 cacheTask 时一直返回 true；只有底层 Promise 的 finally 才释放该状态。IndexedDB/后台通信挂起会使 `handleTranslationTick()` 永久提前返回。同步抛错还可能逸出 tick；快速 Seek 对无法真正取消的读取会累积请求。

**修复**：`translation-coordinator.ts` 为恢复等待设置默认 250 ms 上限，失败/超时冷却默认 5,000 ms。两项均纳入原 Defaults + Sparse Overrides 配置、校验及折叠高级设置，修改后用于后续读取。缓存优先等待到期后继续 Fast/Quality；旧读取仍只保留一个实际在途记录，Seek、stop/start 不会为挂起通信不断追加请求。停止/Seek 撤销等待与发布资格；失败冷却结束可重读当前窗口。迟到且仍有效的历史结果可以恢复，并取消已被其完整覆盖的翻译订阅。

**证据**：原代码 5 项失败及同步异常，见 `convergence-evidence/cache-before.txt`。新测试覆盖挂起读取后双通道继续、100 次 Seek + stop/start 仅一次挂起查询、同步抛错/拒绝的冷却、同窗口冷却后重试、Provider 不可用时优先恢复 Quality、迟到结果取消冗余任务、不再次调度已完成成员、停止后零新增翻译、零剩余任务和计时器。既有 1x/2x/4x、Quality 迟到、回放及完整来源块恢复测试继续通过。

**边界**：AbortSignal 可以立即撤销等待和本会话的结果发布资格，但 IndexedDB 或背景消息本身可能不支持物理中止。对于永久不结束的读取，该 Coordinator 保留一个占用标记，继续播放调度，不再不断追加缓存查询；底层读取真正结束后恢复查询能力。已经发往远端的模型调用也不能承诺被服务器撤回，依旧遵循原调度器的许可及共享订阅语义。

## 4. 无引用配置清理

**根因**：原刷新路径只更新内存注册表，没有清理持久化的已删除 Provider 覆盖项或无引用手动组成员。原分支的运行测试实际观察到 `deleted` 覆盖项仍存在，见 `convergence-evidence/orphans-before.txt`。

**修复**：在既有 `performance-writer.ts` 增加窄范围 reconciliation，与设置 UI 共用唯一串行写入队列。Provider 删除才清除其覆盖，改 Key 时保留该 Provider 自身的有效性能设置。组成员按所有已配置身份引用清理，包含禁用账号和别名；最后一个引用离开后保留空组的名称/策略，等待用户显式重新绑定。解析/持久化失败时不推断组成员已失效；根配置暂时不可读取时不清理。只在配置事件后运行，无变更不写入；不在 timeupdate 或每次请求里查询存储。

**证据**：测试验证别名/禁用账号仍持有旧身份时保留成员；最后一个引用移除后仅成员消失；删除 Provider 清除其覆盖；并发 UI 修改不被覆盖；身份解析不完整、根配置缺失时保留用户设置，配置恢复后继续工作。历史身份 vault、翻译缓存、数据库升级文件均未改动。

## 5. 检查与性能重测

历史 `ACCEPTANCE.md` / `METRICS.md` 保留原来的 `fddc448e → d7e4e8b` 口径。本轮以 `d7e4e8b → ca2948b0` 为主要比较，并额外重跑 `fddc448e`，核查旧报告的尾延迟。

| 检查                  | 结果                                                                                                                | 证据                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 针对性回归            | 9 文件、130 项通过；最终身份更新补验 10 项通过                                                                      | [targeted.txt](convergence-evidence/targeted.txt)、[identity-final.txt](convergence-evidence/identity-final.txt) |
| 完整 Vitest           | **317 文件、2,860 项通过**；SKIP_FREE_API=true                                                                      | [vitest.txt](convergence-evidence/vitest.txt)                                                                    |
| 类型检查与 Lint       | `oxlint --type-aware --type-check`，退出码 0                                                                        | [lint-typecheck.txt](convergence-evidence/lint-typecheck.txt)                                                    |
| 格式检查              | `oxfmt --check .` 通过                                                                                              | [format.txt](convergence-evidence/format.txt)                                                                    |
| 本机生产构建          | WXT 0.21.4 成功，Chrome MV3 输出约 **14.93 MB**                                                                     | [build.txt](convergence-evidence/build.txt)                                                                      |
| 浏览器资源/双通道矩阵 | 基线、修复版各 165 场景，1x/2x/4x、1/2/4/8 并发、慢/失败 Provider，停止后请求及许可泄漏均为 0                       | [基线](convergence-evidence/matrix-baseline/raw.json)、[修复版](convergence-evidence/matrix-candidate/raw.json)  |
| 浏览器生命周期        | 三小时源轨、4x、100 次随机 Seek + 100 次 stop/start；108 次 Mock 调用，停止后新增 0，收尾 active/queued/timers 全 0 | [lifecycle](convergence-evidence/lifecycle-candidate/raw.json)                                                   |
| 浏览器数据库/资源     | 11 项检查通过：v5→v7 数据保留、租约撤销、Worker 失效、独立导出、设置串行写入                                        | [resource](convergence-evidence/resource-candidate/raw.json)                                                     |
| 浏览器侧栏            | 10 项通过，包括 Quality 合并、手动滚动、主动定位、倒退及锚点                                                        | [functional](convergence-evidence/functional-candidate/raw.json)                                                 |
| 网页翻译 Mock E2E     | 冷/热 × 智能上下文开/关 × 3 轮，9 项 DOM/SPA 兼容性检查通过                                                         | [web-e2e.txt](convergence-evidence/web-e2e.txt)、[web.json](convergence-evidence/web.json)                       |

上述浏览器测试运行真实 Chromium 和生产模块，使用本地 Mock。它们不等同于原生 MV3 扩展完整 Service Worker E2E；原生安装仍受环境管理策略限制，见历史验收说明。没有调用真实付费 Provider。保存的文本日志已清理终端颜色、进度刷新和行尾空白，未修改测试、错误或构建结论。

重复测量使用同一 harness、同一 Chromium、顺序运行，禁止与全量测试/构建并跑。每个版本每种基准 5 个新浏览器实例，轮换并反转版本顺序；每实例每个时间轴规模测 50 次 bulk500，10,000 条 SRT 测 10 次完整导出。每个样本原始值保留，分位数采用 nearest rank；首个样本和后续样本分别列出。所有模型调用均为本地 Mock，不消耗真实付费 Token。

```sh
SKIP_FREE_API=true ./node_modules/.bin/vitest run
./node_modules/.bin/oxlint --type-aware --type-check
./node_modules/.bin/oxfmt --check .
./node_modules/.bin/wxt build
node e2e/subtitle-harness/repeat.mjs /workspace/read-frog-convergence-baseline /workspace/read-frog docs/lite/resource-scheduler/convergence-evidence/repeated /workspace/read-frog-baseline
```

### 重测结果

Chromium 版本见各 raw.json；Node v24.19.0。同一台机器顺序执行，重测期间没有并跑全量测试或构建。

| 指标（ms，P50 / P95）                      | 历史 fddc448e | 本轮基线 d7e4e8b | 修复 ca2948b0 |
| ------------------------------------------ | ------------: | ---------------: | ------------: |
| timeline.bulk500，10,000 条（每版 250 次） |     0.4 / 1.4 |        0.5 / 2.2 |     0.5 / 2.5 |
| timeline.bulk500，50,000 条（每版 250 次） |     0.9 / 1.9 |        1.1 / 2.2 |     1.4 / 3.3 |
| 10,000 条完整 SRT（每版 50 次）            |  93.5 / 189.0 |     72.7 / 145.1 |  73.7 / 150.5 |
| 同一字幕内额外 React 提交                  |             0 |                0 |             0 |

原始样本、逐轮分位数及首样本/后续样本：[repeated/summary.json](convergence-evidence/repeated/summary.json)。三版共 30 次浏览器运行、150 次完整万条 SRT 导出；每次都校验 valid=true、count=unique=10,000，每次 2,000 个内容翻译批次。这些批次回调不等同于真实 HTTP 次数。

**时间轴结论**：本轮 50,000 条 P95 的确测得 2.2→3.3 ms，未把它写成性能提升。但只去除 Vite 的 `//#region` 构建路径注释后，基线与修复版的完整时间轴执行产物 SHA-256 相同，且各自 5 次构建都一致，见 [bundle-equivalence.json](convergence-evidence/bundle-equivalence.json)。这为本轮差异来自运行/测量波动、而非时间轴执行逻辑变化提供了直接证据；不需要增加防御代码或修改时间轴算法。旧报告 13.3 ms P95 未稳定复现，历史版重测 1.9 ms、d7e4e8b 重测 2.2 ms。仍有离群点：当前 50,000 条最大 16.8 ms，10,000 条最大 131.0 ms，均保留原始记录。

首个 bulk 样本只表示完整轨发布后的第一次 500 条更新，不等同于惰性索引初始化；初始 upsert 已创建可变时间轴索引。核查后更正了 harness 的说明文字与 raw.json 的 note，没有改变任何计时数据。

**SRT 结论**：旧报告每版只有 3 个样本，其 P95 实际被最大值主导；本次每版 50 次，未证实从历史版到 d7e4e8b 存在稳定的 370.3 ms P95 回归。本轮总体 P95 145.1→150.5 ms，后续样本 P95 104.9→106.3 ms；导出算法没有修改，执行产物差异仅为新增配置定义/空组校验。修复版仍出现 557.7 ms 的最大值，而且位于某轮第 10 次导出，不能把所有尖峰都解释成冷启动，也不宣称长尾已消除。保留完整校验与取消语义，不为降低单项数值改写导出路径。

### 双通道与资源指标复核

下表来自本轮两次 165 场景运行，属于单次矩阵的真实 Chromium 进程指标；不据此宣称稳定的 CPU/内存改善。

| 指标                          |  d7e4e8b | ca2948b0 |
| ----------------------------- | -------: | -------: |
| Mock Provider 实际开始次数    |    6,766 |    6,766 |
| 输入 Token 保守诊断估算单位   |  985,409 |  985,424 |
| 实际 usage                    |     null |     null |
| 取消的 Mock 传输              |    2,325 |    2,325 |
| 安排的重试次数                |       25 |       25 |
| 历史候选缓存查询/命中         |    4 / 4 |    4 / 4 |
| 资源准入拒绝                  |        0 |        0 |
| 停止确认后新增请求            |        0 |        0 |
| 全部 165 场景平均显示前就绪率 | 47.4367% | 47.3988% |
| 主线程 TaskDuration（秒）     |   17.374 |   19.600 |
| ScriptDuration（秒）          |    8.581 |    9.254 |
| 渲染进程 CPU（秒）            |    24.72 |    28.72 |
| 峰值 RSS（MiB）               |   173.50 |   183.55 |
| 结束 JS Heap（MiB）           |    34.70 |    30.88 |

估算单位为源文 UTF-8 字节 + 固定开销的 Mock 诊断，既不代表完整实际提示词 usage，也不用于消费额度或计费；15 个估算单位的差异集中在 1x、并发 2、8 秒 Provider 场景；同样 7 次调用的源文估算稍有差异，该场景首句 8,000→8,007 ms、显示前就绪率 75%→68.75%，也已保留。累计预算拒绝不适用，该系统已删除。上述缓存命中率只涵盖显式预热的 Quality 场景，不能推广为用户总体命中率。汇总见 [matrix-summary.json](convergence-evidence/matrix-summary.json)。

144 个常规组合中，两版都在 88 个慢/吞吐不足组合的 30 秒观察窗内没有首句；成功样本的首句 P50/P95 均为 1,000/8,000 ms，缺失值没有混进分位数。默认并发 2、正常密度、Mock 延迟 1 秒时，两版首句均 1,000 ms，1x/2x/4x 就绪率分别均为 93.75% / 96.77% / 96.72%，请求分别均为 20 / 39 / 35。历史 Quality 缓存场景模型请求及回放新增请求均为 0。

本轮解决的是可复现的身份错配、重复/丢失批次成员和永久缓存阻塞；默认并发、1 秒 Mock 场景的就绪率及调用数保持基线。CPU 和峰值内存在这一组矩阵里较差，已如实记录；只有 bulk500 与 SRT 做了多轮重复测量，不把单次矩阵波动解读为统计保证。

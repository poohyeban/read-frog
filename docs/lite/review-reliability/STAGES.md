# 独立复核与分阶段交付

同步：本地 `c2cafda8` 落后目标分支 13 个提交；2026-10-31 从 origin 拉取并快进到 `50c1395b9d769c69d0ee9e26c5d58b193b5a212b`。只在本地提交；所有 Provider 验证使用 Mock。

## 1. Worker 租约与失败恢复

- 独立复现：拒绝的 leasePromise 被永久缓存；stop Promise 链继承历史 rejection；temporary 成员永久排除。红灯记录见 `evidence/stage1-before.txt`。
- 根因修复：租约增加 Worker boot 身份；只有注册入口返回 `lease-expired`，守卫和同一 boot 的撤销仍拒绝。内容任务只允许一次重放，并发任务以 Promise 身份共享恢复。未知 RPC 失败不自动重放。Stop 立即失效任务，并保留失败撤销供下一次 Stop 确认。
- 失败状态：保留 temporary/permanent/cancelled、Retry-After、Provider 尝试耗尽信息。每来源成员最多两次延迟恢复，1/2 秒退避，最长两分钟；耗尽、取消、配置错误不自动重试。成功缓存清除对应状态。摘要与分段使用同一策略，退避不阻塞 Fast/原文。
- Queue 最终错误保留 `retryExhausted`，业务层不能以新任务 ID 重置 Provider 次数；429 重试仍经原 RequestQueue / ResourceScheduler 的共享冷却。
- 修改范围：session、work runtime、result/recovery、RequestQueue 错误元数据、消息协议、translator、AI segmentation、Coordinator、SegmentationPipeline 及专项测试。
- 结果：9 个测试文件、58 个测试通过（`evidence/stage1-after.txt`），含 32 并发恢复、主动撤销、模糊超时不重放、跨标签验证、100 次 seek 取消和 100 次 stop/start。
- 请求影响：仅明确未执行的租约拒绝可重放一次；已耗尽 Provider 请求不会增加调用。队列准入失败可有限恢复。恢复状态空间为已访问的失败来源数，不在 Tick 哈希全轨。
- 边界：此处验证为确定性 Mock Worker 重建，不等同原生 MV3 Service Worker 终止/重建。原生验收单在最终阶段补齐。

## 2. 原子业务批次

- 独立复现：真实队列工厂中，默认五条短字幕进入两次 Mock transport，见 `stage2-before.txt`。
- 新播放/导出链路一次传输共同快照与成员，后台构建语义计划和实际 Prompt；BatchQueue 提供直接执行已规划批次入口，沿用完整批次缓存、逐成员 AttemptContext、部分失败恢复、RequestQueue 去重及订阅取消。网页和旧内容脚本的定时聚合不变。
- 显式高级成员数/字符限制在内容规划层生效；没有显式覆盖时，业务批次不受第二层默认 4/1000 旋钮拆分。原 batchDelay 对旧逐项聚合继续有效，不作用于已完整提交的业务批次。
- 修改：subtitle-request、message、translator、glossary active matcher、background subtitles handler、BatchQueue/queue factory、Coordinator 和导出规划。
- 32 组真实队列/Mock transport 数据见 `evidence/batching.json`。200ms Mock 延迟、五条短句：IPC 5→1，Provider transport starts 2→1，成员 [4,1]→[5]，首句 200→200ms，第五句 300→200ms。10/20/32 短句以相应合法高级业务批次运行：调用 3/5/8→1/1/1。
- 200 字符长成员按硬字符边界合法拆分，不能把这种拆分计作配置错位。测试覆盖跨标签取消、完整批次缓存及五条中一条空结果只重试该条。
- 使用执行适配器 Mock，数据明确标记 actual HTTP/usage 为 null；不是付费 API 或实际 usage 测量。浏览器 CPU/Heap/React 数据在后续阶段测量。

## 3. 重叠时间轴与候选资格

- 独立复现：两小时长 cue 遮蔽 5,000 条对白；前 128 条永久失败使第 129–140 条永不进入队列。红灯记录 `stage3-before.txt`。
- 明确显示顺序：在既有 Quality > Fast > Original 层级内部，最新开始的有效 cue 优先；同起点选择最短仍有效 cue，再按原始顺序。所有 cue 保留，窗口/来源映射不删除多说话者成员。
- 区间最大结束索引剪枝已过期子树；普通不重叠轨道保持二分查询。window 的数量限制在资格判断之后生效。复杂度：普通 at O(log n)，重叠 at O(log n)，window O(log n + 访问的相交/候选节点)，所有重叠且全部不合资格时仍最坏 O(n)，没有宣称任意重叠为常数时间。
- 真实 Chromium、三小时 50,000 条 + 全视频长 cue：5,000 次随机/倒退查询错误 5000→0；窗口查询 P50/P95 0.059/0.133ms→0.001/0.003ms。显示查询 P95 0.001→0.002ms，正确性优先且绝对增量很小。普通 50,000 条 lookup P50/P95 0.0035/0.005ms，与基线相当。原始 CPU、主线程、Heap、React 提交见 timeline/overlap before/after JSON；Heap 是采样值，未据单次差异推断泄漏。
- 不增加 Provider 或 IPC；这是查询与候选正确性修复。全字幕相关回归 49 文件、445 测试通过；专项结果见 stage3-after.txt。

## 4. 已测量的重复工作

- 基线：真实 Scheduler/atom/转录投影在 50,000 条上每次更新 5 条，30 次样本；identity 全轨重复序列化 P50/P95 13.2/20.1ms，整批发布+投影 16.1/26.4ms。
- 优化：cueIdentity 以 WeakMap 缓存，并比较所有语义字段以兼容旧可变 cue；单 Fast 轨直接共享不可变时间轴快照；相邻发布以弱引用记录差量，转录仅重投影改变的来源行。Quality 合并、跨快照跳跃和非直接映射继续走已验证的完整投影。前驱使用 WeakRef，不能形成保留全部历史数组的链。
- 结果：identity P50/P95 1.8/4.1ms；发布+投影 0.2/0.3ms；投影单独 0.1/0.2ms。renderer CPU 1.92→1.17s，采样 Heap 峰值 101.6→58.0MB。请求与 IPC 均 0→0，投影基准不挂载 DOM 列表，React 提交均 0。独立真实 React 转录基准：50,000 条 update500 P95 34.3→33.1ms，挂载 P95 49.9→34.4ms；该整套基准 CPU 5.58→5.81s、Heap 172→176MB，未把这部分噪声宣称为收益。
- 延迟完成已取消任务还会重复发送 release 控制 IPC（两次 complete 得到两次多余 release），已复现并将 complete 改为幂等；正常一次取消后迟到一次完成，控制 IPC 2→1，不影响取消登记。
- 修改：cue-timeline、scheduler、translated atom 只读类型、transcript、track-publication、session 和专项测试。最坏全量投影仍为 O(n)，常见相邻 Fast 更新为 O(n) 数组引用复制 + O(m) 行投影，未隐瞒数组复制成本。
- 未无依据改造：Ready List、分段全集合和缓冲覆盖保留现状；缓存窗口查询有 256 bundle 上限，不能只因为读过相邻窗口就标记整片缓存完备（会丢结果），未贸然合并窗口。全轨启动哈希与旧兼容身份绑定，留到哈希兼容阶段统一审查。没有引入 Worker/WASM、列式轨道或新运行时。

## 5. 哈希边界、缓存兼容与最终验收

- 独立复现：`("a|b", "c")` 与 `("a", "b|c")` 的旧拼接哈希相同，红灯记录 `evidence/stage5-before.txt`。新增带版本的 JSON 字段元组编码 `Sha256Fields`；保留历史 `Sha256Hex`，没有全库换键、清库或修改 IndexedDB schema。
- 仅升级字幕计划、完整批次实际 Prompt、分段、字幕窗口摘要和候选轨道的多字段身份。普通网页缓存、单 JSON 配置身份、固定长度哈希列表继续兼容。Provider 的完整凭据、账户、语言、Prompt、上下文、术语语义仍参与身份；ResourceScheduler 资源组身份保持独立。
- 旧缓存：已知固定字段数且所有字段均不含 `|` 才允许查询旧键。完整批次/分段/摘要经原校验后提升到新键；候选轨道保留两代安全旧身份读取和真实批次引用验证。含分隔符的旧键无法证明身份唯一，不跨语义读取；旧数据不删除。旧逐 cue LLM 结果不能证明邻句上下文一致，仍不当作完整批次缓存。Lite 当前配置仅支持 LLM，旧免费翻译分支没有现行配置入口，未据此扩大改造。
- 已验证：安全旧完整批次命中且零新增 Provider 请求；含分隔符的旧键不读取；更换凭据不共享缓存；实际 Chromium IndexedDB 5→7 升级保留翻译/分段/术语表与设置。
- 验收补强：RequestQueue timeout/drain 保留尝试耗尽标记；ResourceRejected 保留该元数据；已提交请求的模糊结果/缺失成员不能获得新的业务重试预算。窗口摘要成功后清除失败状态。额外分段/摘要测试验证 Retry-After、最多两次延迟恢复、耗尽不重开、Fast 不阻塞、Stop 清理定时器。非法租约类型仍明确拒绝。
- 实际修改：`hash`、`translation-plan`、`translation-queues`、`ai-segmentation`、`translation-context-summary`、`subtitle-candidates`、`subtitles-translation`、`universal-adapter`、`translator`、结果/队列元数据及对应测试。更细文件列表可直接查看阶段提交。
- 启动开销：轨道/上下文 JSON 序列化各复用一次；新安全键加两代旧兼容键需要三次哈希，旧版两次。真实 Chromium 50,000 条 / 三小时，20 样本，启动键计算 P50/P95 220.8/260.6→317.3/346.9ms，renderer CPU 5.17→7.17s（整套 20 次），采样 Heap 89.2→84.2MB。请求/IPC/React commit 均 0→0。兼容身份增加一次性 CPU 成本，不宣称启动总体加速；这项只发生会话启动，不进入 Tick。原始数据见 startup-before/after。该机器也运行 Mock 验收，墙钟数据不作为严格统计显著性结论。

## 独立复核分类

| 分类                             | 结论                                                                                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 已独立复现                       | leasePromise rejection 缓存、Stop Promise 污染、Mock Worker 重建后旧租约失败、temporary 墓碑、默认 5→4+1、长 cue 遮蔽、先截断导致饥饿、重复 complete IPC、哈希字段碰撞。各阶段红灯证据均保留。 |
| 读码与 Mock 确认，未原生实机复现 | 同一内容页经历真实 MV3 Service Worker 终止/唤醒后的恢复、安全取消及消息迟到。管理策略阻止扩展安装，不能把 Mock 重建写成原生验证。                                                              |
| 依赖配置                         | 默认业务批次 5 和后台聚合 4 的错位；字符/媒体跨度/输出硬限制导致的拆分合理，高级覆盖仍受尊重。长成员不能强制拼成一次超限请求。                                                                 |
| 严重性被高估                     | 配置克隆原本已是每次 translateSubtitles 调用一次；术语表原本已有共享 in-flight 读取。确认的额外成本是逐 cue 匹配、计划、序列化和 IPC，现统一共同快照和批次术语快照。                           |
| 需要基准，保留现状               | Ready List、全分段集合、60 秒缓存读窗、缓冲覆盖计算未证明独立主导瓶颈；有界缓存读取不能无条件合并成“整窗完备”。未引入额外维护结构。                                                            |

## 最终可执行验证

- 完整 Vitest：321 文件、2,908 测试通过（`evidence/vitest.txt`）。设置 `SKIP_FREE_API=true`，遵守仓库禁用外部免费 API 测试的要求。
- 类型检查与 Oxlint：同一仓库命令 `node_modules/.bin/oxlint --type-aware --type-check` 退出 0，原始日志为空表示无诊断。完整格式检查记录在 `evidence/format.txt`。
- WXT Chromium MV3 生产构建成功，总产物 14.94MB，见 `evidence/build.txt`。既有大 chunk / 动静态导入提示保留，没有修改扩展 ID。
- 真实 Chromium Mock：原有 165 场景矩阵全部完成；100 Seek / 100 Stop-Start 的资源清理；11 项 IndexedDB/资源/设置检查；10 项转录 UI/Quality 合并检查；100/1,000/10,000/50,000 条完整 SRT 导出通过。matrix/resource/lifecycle/functional/export 各目录保留原始 JSON、CPU、主线程、Heap、覆盖/尝试/清理数据。Mock usage 标为 null，未伪装成真实 Token 使用。
- 网页翻译生产内容流水线 Chromium 回归通过（`webpage.txt` / `webpage.json`）：冷/热启动、普通/智能模式及 DOM 兼容检查；通用 BatchQueue 未为字幕取消延迟聚合。
- 新增真实本地 HTTP 测试（`subtitle-http.test.ts`）：AI SDK → ResourceScheduler → RequestQueue → BatchQueue → 本地服务器，内容 translator 和 Session 真实，IPC/存储用替身。所有非 localhost fetch 明确拒绝。五条短字幕 IPC 5→1、真实 HTTP 2→1、成员 [4,1]→[5]；单独运行时首句/第五句 71/134→29/29ms；缓存重播零新增 HTTP；一次 429 遵守 Retry-After，一次断连恢复，持续 429 正好 3 次，Stop 后零新增请求且资源归零。请求 Prompt 字节数和时刻见 `http.json`；服务端 usage 是明确标注的合成 100 input / 20 output，不能等同真实模型分词。
- 32 组真实队列工厂实验保留 flush 原因、成员、首/第五句、Prompt 字符、保守 Token 估算、去重与缓存命中字段（`batching.json`）。这里的 IPC 为替身消息边界计数，HTTP 由独立 SDK 测试补足。尚无原生扩展 IPC 的浏览器性能结论；阶段 2 不据此宣称已测得原生 CPU/Heap 加速。
- [原生 MV3 待验收清单](NATIVE-MV3-CHECKLIST.md) 保持未勾选。当前 `ExtensionInstallBlocklist=["*"]`，未绕过管理策略、未修改扩展 ID。

## 中断与暂停完整性检查

用户追加要求后，同时核对了程序意外退出和本轮暂停：Git reflog 中同步快进及八个阶段提交均在；阶段 5 未提交的源文件、测试、浏览器原始数据均存在。`git fsck --full --no-dangling` 与 `git diff --check` 无错误，未发现丢失提交、冲突标记或半截补丁。

当时尚未完成的是第五阶段验收收尾，不是已提交修复被撤销：补齐了真实 HTTP 验证、分段/摘要恢复覆盖、缓存隔离、最终完整测试、生产构建、格式/类型检查和发布说明；对未结束的命令检查完成状态并保留终态日志。最终再拉取目标分支，远端仍为 `50c1395b9d769c69d0ee9e26c5d58b193b5a212b`，当前 HEAD 包含该基线。

所有工作仅本地提交，未 push、未创建 PR、未触发 Actions、未发布 Release。保留 ResourceScheduler、双通道、自适应缓冲、高级配置及缓存校验。

## 复现命令

环境 Node v24.19.0 / Chromium 154.0.8037.57，使用已安装依赖。该环境的 pnpm 与 packageManager 声明不同，因此直接运行已安装二进制，未改 lockfile。

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/oxfmt --check .
SKIP_FREE_API=true node_modules/.bin/wxt build
SKIP_FREE_API=true SUBTITLE_REVIEW_METRICS=/tmp/batching.json node_modules/.bin/vitest run src/entrypoints/background/__tests__/subtitle-request-contract.test.ts
SKIP_FREE_API=true SUBTITLE_HTTP_METRICS=/tmp/http.json node_modules/.bin/vitest run src/entrypoints/background/__tests__/subtitle-http.test.ts
BENCHMARK_KIND=matrix node e2e/subtitle-harness/run.mjs . /tmp/subtitle-matrix
BENCHMARK_KIND=lifecycle node e2e/subtitle-harness/run.mjs . /tmp/subtitle-lifecycle
BENCHMARK_KIND=resource node e2e/subtitle-harness/run.mjs . /tmp/subtitle-resource
BENCHMARK_KIND=functional node e2e/subtitle-harness/run.mjs . /tmp/subtitle-functional
BENCHMARK_KIND=export BENCHMARK_REPEATS=1 node e2e/subtitle-harness/run.mjs . /tmp/subtitle-export
BENCHMARK_KIND=overlap node e2e/subtitle-harness/run.mjs . /tmp/subtitle-overlap
BENCHMARK_KIND=hotspots node e2e/subtitle-harness/run.mjs . /tmp/subtitle-hotspots
BENCHMARK_KIND=startup BENCHMARK_MODE=after node e2e/subtitle-harness/run.mjs . /tmp/subtitle-startup
PERF_RUNS=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node_modules/.bin/playwright test e2e/translation-performance.spec.mjs --reporter=line
```

Before/after 基准均使用同一 harness 与机器：timeline/overlap/hotspots/transcript 的 before 指向独立 `50c1395b` worktree，after 指向当前工作树；startup 比较明确保留在 harness 中的两代启动公式。测试 build 目录已忽略，不纳入代码提交。

## 后续小范围收敛

基于已推送的 `4d65db03`，2026-11-01 完成分段旧缓存删除目标修正、按需历史哈希评估和 165 场景请求差异归因，详见[收敛验收报告](../review-convergence/REPORT.md)。本轮新增工作仍仅保留在本地。

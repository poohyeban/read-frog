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

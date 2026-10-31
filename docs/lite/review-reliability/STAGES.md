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

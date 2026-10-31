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

# 本轮原生 MV3 待验收

状态：未执行。当前管理策略仍为 `ExtensionInstallBlocklist=["*"]`，未绕过策略。沿用[完整原生清单](../review-reliability/NATIVE-MV3-CHECKLIST.md)，本轮额外检查：

- [ ] 默认生产构建使用完整响应；开发实验构建才设置 `VITE_EXPERIMENTAL_SUBTITLE_STREAMING=true`。两者均使用本地 Mock Provider，不调用付费服务。
- [ ] 观察被动租约端口、自然 Worker 休眠与重新唤醒。端口无心跳，不应维持 Worker 常驻；下一次尚未发送的任务可以取得新租约，进行中的流断开后不得自动重放。
- [ ] 在租约回复前关闭页面，在首个 partial 后 Stop，断开其中一个共享订阅者，再断开全部订阅者；确认物理许可等待迭代器关闭，旧 partial 不可见，Stop 确认后无旧请求。
- [ ] 连续 500 次同页视频切换、页面导航和 iframe 导航，穿插丢失 Stop RPC；租约容量不会递增耗尽。主文档导航回收旧子框架，其他标签及独立导出继续。
- [ ] 暂停或隐藏超过 2 分钟及长 Retry-After 后恢复；已耗尽成员不获得新预算，尚未耗尽的安全恢复可以继续。
- [ ] 慢 IndexedDB 与实际 Chrome IPC 下测试 16ms 缓存机会窗口；记录缓存迟到造成的真实 HTTP 开始次数及首句收益，不把客户端 abort 当成服务器撤销。
- [ ] 在普通、reasoning、OpenAI-compatible 测试服务上验证流式协议、真实 usage、首句画面、完整翻译质量和格式开销。未达到质量与成本标准时保持默认关闭。
- [ ] 导入混合历史 Key 与新版本 Key；跨标签继续写旧缓存，确认能够恢复并保持 Provider、账户、配置、来源和术语表隔离。

上述项目均不能由本轮 Vitest、Chromium 页面夹具或模拟端口结果代替。

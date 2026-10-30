# 第二阶段基线与差距

基线：6076134be8ed73367ae24d18f3260ad43f19e8a9，分支 codex/translation-architecture-upgrade，工作区干净。上一阶段最终 278 文件 / 2663 测试通过；同源码归档为本轮浏览器对照，不回退工作区。

| 模块               | 已落实                      | 本轮接管的缺口                                                  |
| ------------------ | --------------------------- | --------------------------------------------------------------- |
| PageSession        | request scope、AbortSignal  | 清理注册、epoch/会话区分、有效性契约、资源所有者                |
| ContextCoordinator | singleflight、LRU、引用计数 | 功能间订阅隔离、真正取消消息、保留有效热缓存、稳定性/有界重试   |
| Document context   | 原文投影、revision          | 追加与整篇替换分类，停用期间的内容失效跟踪                      |
| LocalScheduler     | 共享预算、双 FIFO、公平性   | signal 立即取消、yield 错误恢复、批量任务生命周期、提交阶段预算 |
| TranslationPlan    | 纯缓存身份                  | 不可变完整计划、执行边界、模式/来源/版本/协议元数据             |
| Render             | DOMBatcher、各模式局部保护  | 一致的 Commit Gate，scope/路由/原文/目标判定及排队提交取消      |
| UI 边界            | 原 UI 可用                  | 执行入口移除 Toast；状态快照/聚合订阅/现有命令接口              |
| Manager            | 调用新模块                  | 拆出有独立状态的观察/视口与标题生命周期，保留兼容恢复算法       |

确认的 P0：stop 中全局 clear 影响输入等独立消费者；main/article 追加无条件 document revision；getWebPagePromptContext 无界循环。确认 P1：scheduler yield 异常会卡住 running，stop 不能立即删除排队任务；请求准备依赖具体 Toast；渲染分支有效性规则分散。

按生命周期/上下文、请求规划、调度/渲染、UI 接口、验证清理分阶段实施。继续复用 RequestQueue、BatchQueue、Dexie、Defuddle、Provider Adapter 和布局/恢复逻辑。每阶段本地提交带 [skip ci]；本轮禁止推送、PR、标签、工作流操作，优先遵守用户最新指令。外部服务测试使用 SKIP_FREE_API=true。受管 Chromium 的 MV3 限制将重新验证并明确记录，不绕过。

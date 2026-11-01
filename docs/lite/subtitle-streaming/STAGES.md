# 字幕可靠性、缓存调度与流式实验

基线与远端重新核对为 `2d22b43bfe58571ed593be27dc4f6e99a68f98b5`。本轮仅本地分阶段提交，所有模型使用 Mock。不会自动推送、创建 PR、启动 Actions、发布或更换扩展 ID。

## 阶段 1：失败状态与尝试预算

独立复现两个问题：两分钟期限到达后未使用的安全重试也永久阻止；长 Retry-After 直接变成 Infinity。Seek 离开/回来、长时间隐藏、Stop/Start 的确定性时钟测试均复现。另确认 adapter 的通用 resume 会 clearFailed，从而让自动恢复隐式重置预算。

改动：`recovery.ts` 删除把墙钟期限作为永久屏蔽条件的逻辑，以 clear/waiting/ready/exhausted/manual/cancelled 表达失败状态。首次安全准入失败后最多两次延迟业务恢复，退避 1/2 秒并尊重更长 Retry-After；次数跨 Seek、显隐、暂停和自动 resume 保留。已耗尽 Provider 尝试、模糊传输失败、取消和永久错误不会仅因时间经过而恢复。仅用户明确启用/快捷键重试会清理失败，语义配置/术语变化仍按既有机制建立新会话；非语义设置刷新不重新分配预算。

成功或经验证的历史缓存移除对应失败状态，分段与摘要沿用同一时钟/分类；取消、成功和显式清除重新计算或清除定时器。超长等待使用有界 timer 分段，避免 32 位 timeout 溢出。

物理请求上界不变：每个翻译/分段/摘要逻辑操作仍由自己的 AttemptContext 和 RequestQueue 限制（默认 maxAttempts=3）；明确未发送的准入恢复最多 2 次，消耗 0 个物理许可。未知是否已发送的 RPC/流错误及队列耗尽带 retryExhausted，不获得新的业务额度。长 429 若物理策略已结束请求，仍保持 exhausted，不因 Retry-After 到期自动铸造额度。

红灯见 `evidence/stage1-before.txt`，绿灯见 `stage1-after.txt`。长时间离开后未花掉的恢复由永久空白变为返回窗口后执行一次；耗尽后无新增请求。只改变故障路径，正常成功路径请求/IPC/Token 不变。状态查询仍 O(1)，移除每条记录的过期时间字段；不新增轮询或常驻 worker。这里没有声称可测的正常路径 CPU 加速，测试使用虚拟时钟和本地函数 Mock，不代表真实模型质量或原生 MV3。

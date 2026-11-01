# 字幕可靠性、缓存调度与流式实验验收

基线：`2d22b43bfe58571ed593be27dc4f6e99a68f98b5`，已确认目标分支与该提交一致。实现与证据均保存在本地；未推送、未创建 PR、未触发 Actions、未发布 Release，未修改扩展 ID，也未调用真实付费 API。

## 交付结果

| 阶段      | 结果                                                                                                                                                                                                       | 默认行为                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 失败恢复  | 删除“过期后永久屏蔽”的错误条件；保留 waiting/ready/exhausted/manual/cancelled 区别。每来源最多两次安全业务恢复，已发送/不明确是否发送的失败不借 Seek、显隐或等待重新分配额度。分段、摘要使用相同时间语义。 | 修复生效                                                                          |
| 紧急缓存  | 当前与低水位 Fast 获得 16ms 热缓存机会，远期 Fast、Quality、摘要仍等待普通缓存策略。租约与术语表并行准备；完整覆盖才取消该订阅者的任务。                                                                   | 修复生效，有明确延迟/请求数权衡                                                   |
| 流式实验  | 通过原 RequestQueue、BatchQueue、ResourceScheduler 和 AttemptContext 使用 AI SDK streamText。带版本、显式编号的协议保证成员关联；临时结果不进入正式缓存、Ready 或导出。断流不自动补发完整非流式请求。      | **默认关闭**；仅开发构建 `VITE_EXPERIMENTAL_SUBTITLE_STREAMING=true` 选择实验策略 |
| Reasoning | `length` 为不可自动重试的截断结果，包括 Provider 自己的上限；未闭合 `<think>` 不得显示为译文。流式完整编号成员可以保留，缺失成员继承原尝试预算恢复。                                                       | 校验修复生效；输出预算不扩大                                                      |
| 历史缓存  | 新轨道 Key 加版本前缀，利用现有索引判断是否存在旧格式。保留上版安全摘要与两种严格旧身份恢复；不升级 schema、不清库、不写全局缺失标记。                                                                     | 修复生效；混合历史数据仍支付兼容成本                                              |
| 租约回收  | 在被动连接内申请租约，断连回收；导航清理旧文档及旧子框架。Stop 能终止未响应的申请，长暂停不会按时间被回收。                                                                                                | 修复生效；无 TTL/定时扫描/心跳，不提高 256 上限                                   |

分阶段根因、失败测试、实现文件、成本、边界和本地提交记录详见 [STAGES.md](STAGES.md)。保留原 ResourceScheduler、RequestQueue、BatchQueue、AttemptContext、Session 与双通道架构，没有另建物理限速器。

## 延迟和成本证据

以下全部为本地受控测量，不能代表真实模型质量或收费。

| 对照                                                | 基线                  | 本轮                           | 代价与解释                                                                   |
| --------------------------------------------------- | --------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| 数据库挂起，100ms Mock，首句可见/确认 P50=P95       | 350ms                 | 116ms                          | 紧急窗口可能将五条批次拆成四条，600ms 观察内 Mock 调用 3→4；不是重复成员请求 |
| 8ms 热缓存命中                                      | 8ms、0 调用           | 8ms、0 调用                    | 短机会窗口保留热缓存收益                                                     |
| 40ms 缓存命中                                       | 40ms、0 调用          | 40ms、1 调用                   | 明确的竞态成本；客户端取消不保证服务器撤销                                   |
| 50,000 条/3小时字幕，库内有其他新视频，启动 P50/P95 | 289.0/315.0ms         | 115.9/119.2ms                  | 20 次会话的昂贵历史计算 20→0；实际存在旧记录仍执行安全兼容                   |
| 新批次缓存命中与旧 Key 额外查找                     | 约 0.2ms              | 双查找约 0.3ms                 | 额外查询成本低，保留原实现                                                   |
| 本地 HTTP，首次可用显示回调 P50/P95，10 次/路径     | 完整响应 71.8/147.5ms | 实验流式 12.8/31.3ms           | 确认/整批 P50 为 71.8→74.4ms；这是内容层回调，不是原生扩展画面绘制时间       |
| 同一流式部分完成批次                                | —                     | 1 批次 + 4 缺失成员，共 5 HTTP | 第一个完整成员不重发；最终 HTTP 专项中逐成员最多 2 次，配置上限 3            |

缓存对照 200 场景/版本，流式对照使用实际本地 HTTP、AI SDK generateText/streamText、生产队列及内容翻译函数，消息/端口/存储为模拟边界。逐字符、大块、边界切割、延迟首 token、429、断流、重复/缺失成员、reasoning、截断、Stop、Worker 重建与共享订阅均有回归。自定义 Prompt 在发送前选择完整响应；SRT 保持稳定路径。真实模型的结构化输出质量、真实 Token 分词、价格和各厂商兼容性尚未证明，因此不启用流式默认值。

启动链路按配置、Provider 解析、租约、术语表、完整后台往返、RequestQueue、ResourceScheduler 与 HTTP 首 token 记录。见 [startup-http.json](evidence/startup-http.json) 和 [最终 HTTP 指标](evidence/final-http-stream.json)。模拟端口不提供真实 Chrome IPC 时延；已提供配置快照、禁用术语表的读取也不能假装冷存储读取。实际 IndexedDB、50,000 条源身份计算另有 Chromium 对照，不能遗漏其成本或将重叠的准备阶段相加。

## 165 场景与资源

[逐场景 CSV](evidence/matrix-comparison.csv) 对比上轮完整矩阵：165 个场景请求数全部相同，总数 **6,850→6,850**，重试 **25→25**，就绪覆盖率逐场景一致，估算输入 Token **1,014,621→1,014,621**。Stop 后新增请求为 0，各场景 active/queued/timers 均为 0。慢缓存竞态使用独立对照，没有藏在矩阵汇总中。此前 6,766→6,850 的来源说明仍见[上一轮矩阵分析](../review-convergence/MATRIX.md)。

矩阵本轮 renderer CPU 为 16.21s；83 次 CDP 采样观察到的 JS Heap 最大值为 68,863,944 bytes，属于采样峰值，不是所有瞬间的精确最大值。旧版没有同样的采样峰值，不能据此宣称堆内存下降。Mock Token 仅为估算，真实 usage/费用未知。

租约专项在保留 128 个活动租约时，500 次导航回收 P50/P95 为 8.25/11.5ms；20 轮结束均无租约残留，不引入周期 CPU 工作。500 次 Stop RPC 失败也能经连接断开回收。活跃/长暂停租约、独立导出及其他标签均保持授权，旧租约不能复活。

## 验收记录

- [完整 Vitest](evidence/vitest-full.txt)：**327 个文件、2961 个测试通过**；设置 `SKIP_FREE_API=true`，不调用外部免费/付费翻译服务。
- [类型检查与 Oxlint](evidence/typecheck-oxlint.txt)：使用仓库规定的 `oxlint --type-aware --type-check`，退出 0。
- [格式检查](evidence/format.txt)：`oxfmt --check .`，通过。
- [WXT Chrome MV3 生产构建](evidence/build-mv3.txt)：默认非流式构建，约 14.95MB。保留已有 locale/chunk/动静态导入提示。
- [Chromium 完整矩阵](evidence/matrix/raw.json)：165 场景，无页面错误。
- [Chromium 生命周期](evidence/lifecycle/raw.json)：3小时源、4倍速、100 次随机 Seek 与 100 次 Stop/Start，7 项检查全通过。
- [Chromium 数据库/资源回归](evidence/resource/raw.json)：11 项全通过，包括旧库升级、翻译/术语表/分段保留、索引升级、独立导出、100 次 Stop 零新增请求与无资源泄漏。
- [Chromium 50,000 条字幕 UI](evidence/functional/raw.json)：10 项全通过，包括有界 DOM、恢复定位、手动滚动、倒退 Seek、Quality 合并与锚点保持。
- [真实本地 HTTP 流式专项](evidence/final-http-stream.txt)：47 个受控 HTTP 开始；逐成员最多 2 次；usage 明确为合成值。

原生 MV3 仍被管理策略阻断。本轮没有绕过限制，也没有把模拟 Worker/端口写成原生验收。新增被动端口休眠、iframe 导航和真实画面/质量检查见[独立待验收清单](NATIVE-MV3-CHECKLIST.md)。

## 阶段性本地提交

1. `a00798cc`：失败恢复预算与长时间暂停。
2. `3742647d`：紧急缓存等待与并行准备。
3. `28cd181c`：默认关闭的安全流式实验。
4. `33750137`：Reasoning/截断校验。
5. `046faf3d`：历史轨道索引探针。
6. `c27e0a34`：断连及导航租约回收。

最终验收提交另含 Provider 自身长度上限的回归、HTTP 逐成员次数、矩阵堆采样和完整报告。

## 复现

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/oxfmt --check .
node_modules/.bin/wxt build -b chrome
BENCHMARK_KIND=matrix node e2e/subtitle-harness/run.mjs . /tmp/subtitle-matrix
BENCHMARK_KIND=resource node e2e/subtitle-harness/run.mjs . /tmp/subtitle-resource
BENCHMARK_KIND=lifecycle node e2e/subtitle-harness/run.mjs . /tmp/subtitle-lifecycle
BENCHMARK_KIND=functional node e2e/subtitle-harness/run.mjs . /tmp/subtitle-functional
```

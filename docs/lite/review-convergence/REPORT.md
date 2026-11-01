# 小范围收敛验收（2026-11-01）

后续 `2d22b43b` 基线上的六阶段可靠性与流式实验已记录于[新验收报告](../subtitle-streaming/REPORT.md)。本文保留上轮历史证据。

基于 `4d65db035fc318a493cf8a70291d8d9f45ae5a85`。本轮只修改分段缓存删除目标、历史轨道身份的计算/读取入口与测试证据；ResourceScheduler、Session、TranslationCoordinator、SegmentationPipeline、双通道 Scheduler 均无交付代码变化。只使用本地 Mock，没有推送、PR、Actions 或 Release。

## 1. 无效旧分段缓存的删除目标

已确定性复现：新键未命中，安全旧键命中可解析但时间错位的结果；读旧键期间另一个请求填入有效新记录。原实现删除新键，保留了无效旧记录。红灯见 [segmentation-before.txt](evidence/segmentation-before.txt)。

现在显式记录实际查询命中的 `hitKey`，无效时删除它；有效旧命中则提升到新键，保留原始时间戳。没有用缓存记录内的字段猜测查询来源，也没有改变来源对齐检查或无歧义旧键条件。测试确认旧坏记录消失、有效新记录和无关记录保留，后续读取不再命中坏记录；正常旧缓存提升不调用 Provider。专项 8 测试通过，见 [segmentation-after.txt](evidence/segmentation-after.txt)。

## 2. 按需历史哈希

原实现每次创建播放 Coordinator 之前，都计算新 trackKey 和两个覆盖全轨的历史键。先抽出原公式并用计数测试复现两次无条件历史哈希，见 [identity-before.txt](evidence/identity-before.txt)，再做对照评估。

采用以下保守条件：

- 新身份仍在会话启动时计算，严格保留视频、来源、Provider/凭据、配置、语言及上下文。源文本和配置身份在创建时捕获，延迟执行不受后续对象修改影响。
- 第一次窗口读取先查当前键，并通过既有 `trackKey` 索引的 `< 当前键` / `> 当前键` 两个范围各最多探测一条，确认是否存在其他身份。没有数据库版本升级、全表 payload 扫描或清库。
- 只有没有其他身份时，才能证明无需计算历史键。不能因为当前键命中了一部分，就忽略旧键中其他窗口或 Quality 结果。
- 存在其他身份时，首次按需计算两代安全旧键并在当前会话复用，然后仍按原方法合并/校验新旧缓存。旧消息协议保留，新协议仅服务新的窗口探测入口。
- “没有其他身份”不会被永久记住，后续窗口继续探测，另一标签稍后写入的历史记录仍可恢复。取消之后不再计算历史键或追加缓存 IPC。历史字段含分隔符时仍拒绝有歧义的旧键。

真实 Chromium、50,000 条/三小时、每组 20 样本，实际生产身份函数和真实 IndexedDB（同一轨道 2,000 个 bundle）的对照：

| 场景                   | 身份 + 必要探测 P50/P95 | renderer CPU（整组） | 采样 Heap 峰值 | 历史哈希计算 |
| ---------------------- | ----------------------- | -------------------- | -------------- | ------------ |
| `4d65` 等价三哈希公式  | 293.1 / 318.7ms         | 6.93s                | 105.1MB        | 每次两次     |
| 按需，缓存只有当前轨道 | 116.4 / 123.3ms         | 3.32s                | 97.1MB         | 0            |
| 按需，确有其他身份     | 297.9 / 329.6ms         | 7.24s                | 89.0MB         | 首次仍两次   |

当前轨道场景的索引探测 P50/P95 为 1.1/1.7ms；有其他身份时为 1.1/3.5ms。相比同轮 eager 对照，当前轨道场景 P50 降低约 60%。上一报告的 317.3ms 属于前一次运行，不能拿不同轮次直接宣称同等比例。

这是身份计算与存在性探测的基准，不是完整播放器首屏时间；不挂载 React、不开 Provider，调用数均为 0。计时排除 IPC。无其他身份时仍每窗口一次缓存 IPC；第一次存在其他身份时多一次探测 IPC，此后每窗口仍一次。真实 CPU、Heap、主线程、原始样本见 [startup-eager](evidence/startup-eager/raw.json)、[startup-lazy](evidence/startup-lazy/raw.json)、[startup-historical](evidence/startup-historical/raw.json)。不根据单次 Heap 差异推断泄漏。

保守边界：其他轨道即使也是新版数据，仍可能使本会话计算旧身份；不靠猜测区分版本，所以多轨历史库并非一定提速。历史路径的总成本没有改善，首次缓存等待也包含延迟计算；原有 250ms 缓存等待/迟到恢复语义未改动，慢设备或慢数据库仍可能先展示/请求 Fast，再接收迟到缓存。两代旧键与 Provider/配置隔离均由测试覆盖。

生产修改范围：`track-identity.ts`、`candidate-reader.ts`、`universal-adapter.ts`、`subtitle-candidates.ts` 和消息协议；未改动调度核心。

## 3. 6,766 → 6,850 的解释

详见 [逐场景分析](MATRIX.md)、[165 行 CSV](evidence/matrix-comparison.csv) 和 [JSON](evidence/matrix-comparison.json)。只有 12 项变化，10 项增加 139 次，2 项减少 55 次，净增 84；153 项不变。

新增请求主要完成了过去被前 128 条截断挡住的远期来源；没有重复 Fast 成员、额外重试或缓存命中变化。1 次额外请求属于末尾 Seek 后的有效预取，被随后的 Stop 取消，没有增加完成量。更完整批次使另两个场景请求减少。矩阵不走后台 BatchQueue/真实 HTTP，所以不将它与之前后台 4+1 问题混淆。

额外做了单变量因果对照：在独立的 `4d65` worktree，只改回先截断再过滤，12 个场景全部恢复旧计数。见 [控制补丁](evidence/window-control.patch) 和轨迹。诊断回退未进入交付源码，没有为压低数字破坏已修复的候选覆盖。

本轮完成后的完整 165 场景仍为 6,850，各场景请求数与 `4d65` 完全相同，Stop 后新请求 0、资源残留 0，见 [最终摘要](evidence/matrix-final-summary.json)。

## 回归与交付

- 专项：缓存来源删除、正常提升、延迟哈希只计算一次、配置/凭据隔离、部分新缓存 + 旧缓存、跨标签后续写入、取消、两侧索引探测，以及 adapter 100 次开关。早期专项 68 项通过；新增另一侧索引场景后，最终 69 项纳入完整套件。
- 完整 Vitest：323 文件、2,922 测试通过，设置 `SKIP_FREE_API=true`，见 [日志](evidence/vitest.txt)。没有调用真实付费接口。
- 类型检查 / Oxlint：仓库同一命令 `oxlint --type-aware --type-check` 退出 0，见 [日志](evidence/lint-typecheck.txt)。
- 全仓格式检查：通过，见 [日志](evidence/format.txt)。
- WXT Chromium MV3 生产构建：成功，14.94MB，见 [日志](evidence/build.txt)。保留既有 chunk 大小及动静态导入提示。
- Chromium Mock：165 场景完成；新增 12 场景旧/新/控制轨迹和 3 组启动对照。原生 MV3 生命周期验收仍不在这些结果内，沿用[独立待验收清单](../review-reliability/NATIVE-MV3-CHECKLIST.md)。

## 复现

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/oxfmt --check .
SKIP_FREE_API=true node_modules/.bin/wxt build
BENCHMARK_KIND=matrix node e2e/subtitle-harness/run.mjs . /tmp/convergence-matrix
BENCHMARK_KIND=matrix MATRIX_CASES=49,97,109,121,133,155,159,160,161,162,163,164 node e2e/subtitle-harness/run.mjs . /tmp/convergence-trace
BENCHMARK_KIND=startup-convergence BENCHMARK_MODE=eager node e2e/subtitle-harness/run.mjs . /tmp/convergence-eager
BENCHMARK_KIND=startup-convergence BENCHMARK_MODE=current-only node e2e/subtitle-harness/run.mjs . /tmp/convergence-lazy
BENCHMARK_KIND=startup-convergence BENCHMARK_MODE=historical node e2e/subtitle-harness/run.mjs . /tmp/convergence-historical
node e2e/subtitle-harness/compare-review-matrix.mjs
```

旧轨迹的源码参数使用 50c1395b 独立 worktree；控制轨迹使用 4d65db03 加所附单行补丁。所有对照共用同一 harness、确定性虚拟时钟和本地 Mock。日志只清理终端进度动画与行末空白，保留诊断、失败断言与最终状态。

# 第二阶段性能与验证

## 方法

同一容器、Node v24.19.0、Chromium 154.0.8037.57，串行运行两个源码版本：第一阶段 `6076134b` 的独立归档，以及第二阶段最终源码。未回退工作区。每个版本 600 段文章，智能上下文开/关 × 冷/热缓存 × 5 次，共 20 样本；模拟 Provider 固定 80ms，标题翻译关闭，加载真实生产翻译样式。P50 取中位数，P95 取 nearest-rank（5 次样本下即最大值），不提供统计显著性断言。

最终源码连续复测原始数据：[phase1.json](./performance/phase1.json)、[phase2.json](./performance/phase2.json)。首轮中间源码诊断也保留为 [phase1-initial.json](./performance/phase1-initial.json)、[phase2-initial.json](./performance/phase2-initial.json)，没有合并进最终统计。首轮智能热 P50 为 69.6→43.0ms，智能冷为 377.2→393.6ms；与复测一起说明热缓存计数改善可重复，冷启动差额有明显波动，不能宣称稳定冷启动提速。两版均使用同一测试夹具；新增提取/parse/消息时间记录只存在于 Vite 测试 transform，未修改生产算法。浏览器 DOM、布局、扫描、上下文和渲染是真实实现，扩展 storage/messages、模型和持久缓存为模拟。它不等于真实 MV3 E2E，也不测真实模型延迟或质量。

冷缓存为新浏览器页面；热缓存为同文档停止、恢复原文、再次启动。计数窗口为启动到首段出现后 250ms；随后记录 PageDown 交互。峰值堆每 25ms 经 CDP 采样，停止后显式 GC。基准运行期间未并行跑编译或单元测试。

## 首段与工作量

所有箭头为第一阶段 → 第二阶段。

| 智能上下文 / 缓存 |   首段 P50 ms |   首段 P95 ms | Long Task 总数（5 样本） | 单次 Long Task 总耗时中位数 ms | 正文提取次数中位数 | textContent 读取次数中位数 |
| ----------------- | ------------: | ------------: | -----------------------: | -----------------------------: | -----------------: | -------------------------: |
| 关 / 冷           | 166.9 → 168.7 | 177.2 → 179.1 |                    0 → 0 |                          0 → 0 |              0 → 0 |                1672 → 1744 |
| 关 / 热           |   34.8 → 46.1 |   43.5 → 47.8 |                    0 → 0 |                          0 → 0 |              0 → 0 |                1350 → 1466 |
| 开 / 冷           | 387.1 → 390.3 | 391.8 → 394.6 |                    5 → 5 |                        73 → 75 |              1 → 1 |                9530 → 9602 |
| 开 / 热           |   79.7 → 42.1 |   94.7 → 54.8 |                    1 → 0 |                          0 → 0 |              1 → 0 |                9208 → 1466 |

| 场景    | 摘要消息 | 摘要模型调用 | 翻译模型调用 | 模拟持久翻译缓存命中 | walked 属性写入 |
| ------- | -------: | -----------: | -----------: | -------------------: | --------------: |
| 关 / 冷 |    0 → 0 |        0 → 0 |      24 → 24 |                0 → 0 |       603 → 603 |
| 关 / 热 |    0 → 0 |        0 → 0 |        0 → 0 |                0 → 0 |       603 → 603 |
| 开 / 冷 |    1 → 1 |        1 → 1 |      24 → 24 |                0 → 0 |       603 → 603 |
| 开 / 热 |    1 → 0 |        0 → 0 |        0 → 0 |                0 → 0 |       603 → 603 |

调用计数为 5 次中位数；热翻译命中页面内存层，所以持久翻译缓存为 0。提取计数沿用 `createHTMLDocument` 代理；本轮还直接测量了提取函数。walked 写入是扫描工作量代理，不等于完整树遍历次数。

智能热缓存 P50 下降约 47%，收益来自明确的文档所有权：停止整页不再清空仍有效的原文与共享摘要，同时保留文档观察器验证失效。没有减少上下文质量。关闭智能上下文冷启动增加 1.8ms、热启动增加 11.3ms；开启冷启动增加 3.2ms。完整快照、版本检查和协作阶段带来额外工作，帧对齐也影响小样本时延；本轮没有足够证据把差额全部归因于某一个新模块，不宣称冷启动优化成功。

## 智能上下文为什么限制冷启动收益

同一提取函数外层记录包含动态模块载入、原文投影、Defuddle 和 Markdown 转换；单独记录 `Defuddle.parse()` 的同步耗时。开/冷中位数：

| 等待或工作                      | 第一阶段 ms | 第二阶段 ms |
| ------------------------------- | ----------: | ----------: |
| 正文提取总时长                  |       180.3 |       180.9 |
| 其中 Defuddle 同步 parse        |        42.5 |        42.4 |
| 从启动到发出摘要消息            |       221.9 |       224.0 |
| 摘要模拟 Provider 等待          |        80.3 |        80.3 |
| 摘要就绪到首个翻译请求          |         2.6 |         3.2 |
| 翻译模拟 Provider 等待          |        80.2 |        80.3 |
| 首个翻译结果就绪到首段 DOM 可见 |         1.9 |         1.9 |

各阶段分别取中位数，不能将表中各行直接相加当作某一次样本。关键依赖链为“正文提取 → 摘要完整结果 → 翻译完整结果 → DOM”。即使扫描优化，必要的提取和两次模型等待仍在串行依赖路径上。Defuddle 单次同步 parse 接近一帧的数倍，前后投影/转换也不能被本地预算强制抢占；这解释了智能冷启动仍有 Long Task。

第一阶段热启动虽不用再调用摘要模型，却重新提取一次正文（总耗时中位数 61.4ms，parse 中位数 26.6ms）并发送摘要缓存查询。第二阶段热启动提取和摘要消息均为 0，这是可由计数直接验证的改善。未更换 Defuddle、减少文章内容、跳过必要摘要或改 Prompt。

## 交互、Mutation 与内存

| 场景    | 启动最大帧间隔中位数 ms | 滚动最大帧间隔中位数 ms | PageDown → 下一帧中位数 ms | 采样峰值 JS 堆 MB | 停止 + GC 后 JS 堆 MB |
| ------- | ----------------------: | ----------------------: | -------------------------: | ----------------: | --------------------: |
| 关 / 冷 |            83.4 → 100.0 |             16.8 → 16.8 |                13.9 → 11.2 |     12.34 → 13.96 |           7.76 → 7.88 |
| 关 / 热 |             49.9 → 50.0 |             16.7 → 16.7 |                 6.6 → 13.6 |     10.95 → 10.51 |           8.01 → 8.14 |
| 开 / 冷 |             83.3 → 66.7 |             16.8 → 16.7 |                  6.1 → 8.0 |     17.57 → 16.13 |           9.42 → 9.55 |
| 开 / 热 |             83.3 → 50.0 |             16.8 → 16.7 |                 11.2 → 9.7 |     14.03 → 13.11 |           9.67 → 9.78 |

两版 8 类夹具全部通过：Wikipedia 型浮动布局、Markdown/GitHub 脚注、Shadow DOM、巨型段落、SPA、同 URL 主区替换、连续 Mutation、摘要 pending 时正文新增。每类还验证仅译文停止后原文精确相等。

30 次同步文本 mutation 到重译可见的单次观测为 107.0 → 108.9ms；这是包含调度、模拟网络和断言轮询的端到端耗时，**不是 MutationObserver 纯 CPU 成本**，单样本不能声称稳定吞吐提升。新增单元契约证明追加不重提全文、整篇替换失效和稳定性等待有界。

滚动保持约一帧间隔；输入到帧的差异受按键时刻与 RAF 对齐影响，不能宣称所有交互均提速。停止后堆略有增加（见表），包含有界缓存和文档观察器；短时采样不包括后台/GPU/进程内存，也不能证明长期无泄漏。单次不可抢占工作和冷启动成本仍是后续优化方向，需要额外 profiling 与质量依据。

## 最终验证

- Vitest：285 个测试文件 / 2,687 项测试通过，102.43s；`SKIP_FREE_API=true` 明确跳过 live 免费服务，未测试真实外部服务。
- 收尾补测：配置损坏通知也能安全失效并回退默认值，配置/提交相关 2 文件、5 项测试通过；未改变正常配置的性能路径。
- 类型与静态检查：`oxlint --type-aware --type-check`。
- 格式检查：`oxfmt --check .`。
- WXT Chromium MV3 生产构建：通过，14.77MB；与第一阶段重新构建的 manifest 逐字段相同，扩展身份、权限和入口未变。
- 同环境浏览器对照：第一阶段 1 passed / 28.5s；第二阶段 1 passed / 27.8s，每个包含 20 个性能样本与 8 类兼容检查。
- 真实 MV3：另行执行 `e2e/extension.spec.ts`。等待 `serviceworker` 15 秒超时。只读检查确认 `/etc/chromium/policies/managed/extensions.json` 的 `ExtensionInstallBlocklist` 为 `["*"]`，受管 Chromium 不允许加载该 unpacked 扩展；完整扩展 transport/UI E2E 尚不能验收。没有绕过浏览器管理策略，其他依赖扩展加载的 E2E 不能由 harness 代替。

## 复现

```bash
# 源码基线归档，不修改当前工作区；为归档准备依赖和 WXT 生成文件。
mkdir -p /tmp/read-frog-phase1
git archive 6076134be8ed73367ae24d18f3260ad43f19e8a9 | tar -x -C /tmp/read-frog-phase1
ln -s /workspace/read-frog/node_modules /tmp/read-frog-phase1/node_modules
(cd /tmp/read-frog-phase1 && ./node_modules/.bin/wxt prepare)

# 两条性能命令串行执行，运行时不要并行编译或测试。
PERF_LABEL=phase1 PERF_SOURCE_ROOT=/tmp/read-frog-phase1 PERF_OUTPUT_DIR=/tmp/read-frog-phase2-perf PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium ./node_modules/.bin/playwright test e2e/translation-performance.spec.mjs
PERF_LABEL=phase2 PERF_OUTPUT_DIR=/tmp/read-frog-phase2-perf PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium ./node_modules/.bin/playwright test e2e/translation-performance.spec.mjs

SKIP_FREE_API=true ./node_modules/.bin/vitest run
./node_modules/.bin/oxlint --type-aware --type-check
./node_modules/.bin/oxfmt --check .
./node_modules/.bin/wxt build
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium ./node_modules/.bin/playwright test e2e/extension.spec.ts
```

本环境安装的 pnpm 会尝试向不可写 home 安装另一个版本，因此直接使用仓库已安装二进制；未改变 package.json、lockfile、CI 或扩展身份配置。

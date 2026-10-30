# 验证与实测

## 环境与测量边界

2026-10-30，同一云端 Linux 工作区、Node 24.19.0、Chromium 154.0.8037.57、同一依赖安装和 Vite 生产压缩；两版都加载生产翻译样式，并断言 stylesheet 成功加载。基线源码为 `18f2c8cbfddc3df5e4b7552a48b1731c28ac4cfd`，通过 git archive 放入独立临时目录，无回退或覆盖工作区。

浏览器 harness 执行真实生产 PageTranslationManager、遍历、上下文、Defuddle、翻译准备与 DOM 插入；仅替换扩展 storage/message transport、i18n 外壳和模型响应。Provider 固定本地模拟 80ms，模拟后台成功缓存及摘要去重，不消耗用户 Key。RequestQueue 的实际重试/作用域引用计数另外由 Vitest 集成测试覆盖。此数据是 **真实 Chromium DOM + 模拟服务实验，不是完整 MV3 E2E，也不代表真实模型翻译质量或网络性能**。

600 段静态文章；智能上下文开/关 × 冷/热各 5 次，共每版本 20 个样本。热启动是在同页 stop 后 restart，保留翻译内存缓存与模拟服务缓存。首段延迟从 start 到观察到译文落地；P95 使用 nearest-rank，5 样本的 P95 实际就是最大值，不能作稳定尾延迟保证。两个版本串行测量，未与编译/单元测试并跑。

原始数据：[baseline.json](measurements/baseline.json)、[upgrade.json](measurements/upgrade.json)。报告下列数字均来自原始数据，不使用理论提升百分比。

## 首段延迟、长任务与请求次数

| 智能上下文 / 缓存 | 首段 P50 基线→升级 ms | 首段 P95 基线→升级 ms | Long Task 数中位数 基线→升级 | Long Task 总时长中位数 基线→升级 ms |
| ----------------- | --------------------: | --------------------: | ---------------------------: | ----------------------------------: |
| 关闭 / 冷         |         893.9 → 166.6 |         953.4 → 174.9 |                        2 → 0 |                             140 → 0 |
| 关闭 / 热         |           87.5 → 36.2 |          101.2 → 37.3 |                        1 → 0 |                              65 → 0 |
| 开启 / 冷         |         389.9 → 386.3 |         406.3 → 397.9 |                        1 → 1 |                             78 → 73 |
| 开启 / 热         |           90.3 → 86.5 |          91.3 → 114.3 |                        1 → 0 |                              69 → 0 |

| 场景      | 正文提取 基线→升级 | 摘要消息 基线→升级 | 模拟摘要调用 基线→升级 | 模拟段落调用 基线→升级 | textContent 读取中位数 基线→升级 |
| --------- | -----------------: | -----------------: | ---------------------: | ---------------------: | -------------------------------: |
| 关闭 / 冷 |             24 → 0 |              0 → 0 |                  0 → 0 |                24 → 24 |                    196289 → 1672 |
| 关闭 / 热 |              0 → 0 |              0 → 0 |                  0 → 0 |                  0 → 0 |                      1420 → 1350 |
| 开启 / 冷 |              1 → 1 |             24 → 1 |                  1 → 1 |                24 → 24 |                      9278 → 9530 |
| 开启 / 热 |              0 → 1 |             24 → 1 |                  0 → 0 |                  0 → 0 |                      1420 → 9530 |

段落覆盖未减少：静态用例每次均有 603 次 walked 标记写入，首屏冷启动 24 次段落模拟请求。walked 写入不是完整遍历次数；textContent getter 全局插桩也包含提取器和测试观察器，不能等同于“源区域全文检查次数”。后者由单元测试证明：30 个同区域 Mutation 目标仅读源文本一次，下一批再读一次。

开启智能上下文后，冷启动仍做 1 次摘要模型调用；热启动 0 次模型调用，页面摘要消息由 24 条降至 1 条。stop 明确释放正文缓存，因此升级版热启动重新提取 1 次正文，读取量增加；这是生命周期正确性的成本，未将它隐藏为全面收益。热翻译命中页面内存层，模拟持久翻译缓存 hits 为 0；跨会话摘要持久命中由模型调用 0 和真实后台缓存集成测试共同验证。

智能上下文开启时，冷启动 P50 只从 389.9ms 到 386.3ms，没有证据认定稳定提速；热启动 P95 从 91.3ms 到 114.3ms，采样堆峰值也更高。主要确定收益是消息去重与生命周期正确性，不能把关闭智能上下文的改善推广到开启场景。

## 交互与内存

| 场景      | 启动窗口最大帧间隔中位数 基线→升级 ms | 滚动窗口最大帧间隔中位数 基线→升级 ms | PageDown 到下一帧中位数 基线→升级 ms | 采样峰值堆内存 基线→升级 MB | stop + GC 后堆内存中位数 基线→升级 MB |
| --------- | ------------------------------------: | ------------------------------------: | -----------------------------------: | --------------------------: | ------------------------------------: |
| 关闭 / 冷 |                          116.7 → 83.3 |                           16.7 → 16.7 |                            9.4 → 8.3 |               19.45 → 12.43 |                          10.58 → 7.76 |
| 关闭 / 热 |                           66.6 → 50.0 |                           16.8 → 16.7 |                           8.0 → 12.5 |               13.57 → 10.94 |                          10.66 → 8.01 |
| 开启 / 冷 |                           66.8 → 83.3 |                           16.8 → 16.7 |                          12.1 → 13.4 |               16.28 → 18.79 |                          10.04 → 9.42 |
| 开启 / 热 |                           66.6 → 66.7 |                           16.7 → 16.8 |                           6.9 → 11.7 |               13.22 → 14.60 |                          10.11 → 9.67 |

峰值是每 25ms 经 CDP 采样的最大 `usedSize`，可能漏掉采样间的瞬时峰值；stop 后使用 Performance.getMetrics 的 JSHeapUsedSize。它是短时页面 JS 堆指标，不包括扩展后台、GPU、浏览器完整进程内存，不能证明长期无泄漏。部分场景的采样峰值或帧间隔仍有波动；滚动结果在一帧量级，没有充分证据声称交互有普遍改善。保留现有 DOMBatcher 和成熟布局测量，不进行高风险布局重写。

## 正确性与构建

- 基线：271 个 Vitest 文件 / 2626 项测试通过，91.05s。
- 升级：278 个 Vitest 文件 / 2663 项测试通过，95.62s；新增共享上下文、摘要队列、规则版本、缓存身份、配置切换、调度公平性、Mutation 去重、原文投影与架构边界测试。
- TypeScript + Oxlint：`oxlint --type-aware --type-check`。
- 格式：`oxfmt --check .`。顺带修正一个基线已有 release 文档表格的排版，不改其内容。
- WXT Chromium 生产构建通过，约 14.73 MB；manifest 与基线逐字段相等，没有改变扩展 ID、权限或入口。
- 浏览器升级版：20 个测量样本与 8 类兼容用例通过，27.4s。浮动布局、Markdown/脚注、Shadow DOM、巨型段落、SPA、同 URL 主区域替换、高频 Mutation、摘要 pending 时正文增补；每类覆盖双语、仅译文、停止后原文精确恢复。
- 基线浏览器：20 个测量样本已保存，前 6 类兼容用例通过；高频 Mutation 后仅译文 stop 恢复失败（预期 111450 字符，实际 111126），基线测试退出码为 1。升级修复该迟到结果问题，未降低原文相等断言。
- 收尾另复现并修复：摘要 pending 时正文增补导致旧上下文失效、未变的可见段落遗漏。仍有效会话现在重新加入新 revision 的共享上下文；取消、导航与 Provider 错误不因此重试。
- `SKIP_FREE_API=true`：跳过真实免费服务探测，不宣称外部服务通过。

完整扩展 Playwright `e2e/extension.spec.ts` 已尝试，15s 等待 serviceworker 超时。受管 Chromium 禁止加载 unpacked 扩展；CDP 的明确错误为 `Loading of unpacked extensions is disabled by the administrator.`。未绕过策略，**完整 MV3 transport/扩展 UI 验收仍被环境阻断**。未运行其余同样依赖扩展加载的运行时/字幕 E2E；浏览器 harness 通过不能替代这些检查。

## 复现

使用仓库已安装 CLI（本环境 pnpm 版本自动安装需要不可写的 home，因此直接调用对应二进制；未更改 lockfile）：

```bash
SKIP_FREE_API=true ./node_modules/.bin/vitest run
./node_modules/.bin/oxlint --type-aware --type-check
./node_modules/.bin/oxfmt --check .
./node_modules/.bin/wxt build
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium ./node_modules/.bin/playwright test e2e/extension.spec.ts
```

浏览器对照需先将固定基线 archive 到临时目录，并链接同一 node_modules；全程没有切换工作树或安装其他依赖：

```bash
mkdir -p /tmp/read-frog-baseline
git archive 18f2c8cb | tar -x -C /tmp/read-frog-baseline
ln -s "$PWD/node_modules" /tmp/read-frog-baseline/node_modules
PERF_LABEL=baseline PERF_SOURCE_ROOT=/tmp/read-frog-baseline PERF_OUTPUT_DIR="$PWD/docs/translation/measurements" PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium ./node_modules/.bin/playwright test e2e/translation-performance.spec.mjs
PERF_LABEL=upgrade PERF_OUTPUT_DIR="$PWD/docs/translation/measurements" PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium ./node_modules/.bin/playwright test e2e/translation-performance.spec.mjs
```

基线兼容性失败是被测缺陷，应保留失败输出和 samples，继续单独运行升级命令。`PERF_RUNS` 可增加测量次数；不要与其他高 CPU 验证并跑。使用独立 PERF_OUTPUT_DIR，避免 Playwright 清空 test-results 时丢失两版数据。

## 验收覆盖索引

| 要求                                                       | 自动化证明                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 30 次同正文/摘要共享、成功缓存、失败冷却                   | webpage-context / webpage-summary / context-coordinator / translation-context-summary 测试 |
| 429、Retry-After、网络、超时、权限、最后订阅取消           | translation-context-summary 的真实 RequestQueue 集成测试                                   |
| 可信标签 scope、导航只释放旧会话                           | translation-queues handler 集成测试                                                        |
| SPA 晚到、同 URL 失效、锚点保留                            | webpage-context 测试 + 浏览器 spa / virtual                                                |
| 无摘要模板不调模型、配置/Provider 在途切换、模板与缓存一致 | translate-text / translation-plan / translation-queues / api/ai 测试                       |
| 规则版本失效、异常输出不缓存                               | translation-context-summary 测试                                                           |
| Mutation 30 次只查一次、宿主篡改/同步接续                  | mutation-source-budget + 原有 page-translation-mutations / rewrite-carry                   |
| 30 个视口任务共享预算、网络不串行、公平调度                | local-scheduler / traversal-chunked / translation-walker-liveness                          |
| 停止晚到、重启、释放、双语/仅译文                          | 原有 Manager/DOM 回归 + context-coordinator + 浏览器 8 类 fixture                          |
| Shadow DOM、巨型段落、动态/虚拟页面、公式与术语表          | 原有完整 Vitest 回归 + 浏览器 fixture；真实网站人工验收未宣称完成                          |

## 发布边界与下一步

用户后续授权推送代码，继续明确禁止运行 GitHub Actions。目标是独立 `codex/translation-architecture-upgrade` 分支；所有本轮提交带 `[skip ci]`，不推送标签、不创建 PR、不更改工作流。远程 main 在检查时仍是本轮基线；其工作流只在 `codex/read-frog-independent` push、main PR、v* 标签或手动触发，新分支 push 不匹配。现有其他草稿 PR 不属于本次合并范围。推送后只读核对分支和关联 workflow runs。

后续可选工作：在允许扩展加载的环境完成 MV3 端到端验收；使用经授权、离线可评审语料验证不同 Provider 的摘要预算质量；增加大样本、反向顺序浏览器对照和长时 SPA/内存 soak；对保留的 Defuddle 同步长任务先 profile，再决定是否进一步分阶段准备。没有真实质量证据前，不替换正文采样策略。

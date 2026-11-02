# Context Engine V2：生产级可靠性收敛审查

结论：**CONDITIONAL**。本地正确性、请求预算、资源回收、类型检查与生产构建均通过。信息流冷启动及真实变更验证仍有测得的性能开销；原生 MV3 被管理策略阻止。以下结论不能代替正式发布验收。开发验收阶段未推送、未创建 PR、未触发 Actions、未发布，也没有调用付费 API。

## 基线和范围

目标分支 `codex/subtitle-engine-v2`。开始时工作区干净，已 fetch 远端；最新 HEAD 与指定基线均为 `7321d6f9ada3a0335a876b2c076aebe4cdc4b0b5`，提交差异 0、文件差异 0。对照 worktree 的生产代码保持该提交；只加入同一回归 fixture，SDK fixture 仅修改报告输出路径。

本轮审阅了 ARCHITECTURE、INVARIANTS、MIGRATION、PERFORMANCE、RISK_REGISTER、TEST_REPORT，以及 invalidation、scope-resolver、snapshot-manager、document-lifetime、render-guard、source-document、webpage-context、webpage-summary、summary-policy。生产修改限于前三个 context 模块与 source-document；没有改写 V2、队列、Scheduler、字幕或 Hub，没有调整缓存 schema、扩展 ID 或自动尝试额度。

旧报告中的 1af30d16 → V2 对比属于前一轮。本轮的固定基线就是 7321d6f9，不能再次使用旧的请求减少数字证明本轮收益。

## 确认缺陷和修复依据

| 范围            | 基线代码根因及证据                                                                                                                                                                        | 修复                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 属性失效   | `invalidation.ts` 的任意匹配属性记录立即调用 changed；`snapshot-manager.ts` 直接 dirty/generation++。hover、粗体、动画类和装饰 style 导致重复投影，准备中反复发生可耗尽两个本地准备机会。 | 观察器只登记 source/semantic/visibility/unknown 候选。按需用同一有界原文遍历验证真正参与提取的数据；装饰变化保留快照和对象身份。                                        |
| P0-1 元数据依赖 | attributeFilter 缺少 meta 的 content 等字段；已有 heading 时不登记 head，heading 删除后的标题回退不会继续跟踪网页标题。                                                                   | 补齐实际读取属性；允许全局元数据的作用域登记潜在 head 依赖，验证仍只比较真正使用的字段。未使用正文不再重建仅标题快照。                                                  |
| P0-2 集合归属   | `knownCollectionItems` WeakSet 无退出条件；通用重复 div 又缺少最后幸存成员的有效记忆。宽泛 main 也可能因内含 bookmark 被错误视为成员。                                                    | 成员 WeakMap → 当前父容器 WeakRef + 语义签名。只有相同容器/签名保留旧证明；变更后重新证明。容器签名弱缓存必须先比较实际字段；不扫描整个集合，不把运行时身份放入持久键。 |
| P0-3 投影隐私   | `source-document.ts` 未排除 opacity:0、content-visibility:hidden、inert、扩展 Shadow host 祖先；直接传入其他 frame 的节点也未拒绝。                                                       | 共用投影/验证资格判定，检查至多 64 层祖先和 Shadow host，拒绝其他 browsing context。保留原始文本恢复、正常 SVG、非零透明度、屏幕外及裁剪无障碍文本。                    |

前两行是相同的“候选变化直接等同于有效上下文改变／依赖不完整”问题；集合生命周期和投影资格分别是独立的所有权、隐私问题。没有为任何网站、域名或翻译模式添加例外。

## 实现、安全性与计算边界

- class/style 继续被观察；class 名称不按字符串前缀猜测是否装饰。结构和资格相同但 class 不同时，对有界、脱离页面的原始表示运行现有解析器，确认实际输出相同才复用。验证最多保留每次投影 64 KiB 标记数据；标记在解析前删除，不进入 Prompt 或缓存键。超预算或解析结构歧义保守重新提取。
- body 仍为每根 2048 节点／2000 字符，heading 256／512，显式引用总输出保持原预算。验证不复制 live DOM，不使用全页 textContent。样式资格在一次遍历内复用。
- 读取前 flush 记录；异步准备返回后再次 flush/验证，最后验证与发布间没有 await。真实内容变化保留原有最多两次本地准备，未扩大发送后的模型重试；失联节点不能发布新上下文。准备期装饰变更不再成为 CONTEXT_STALE。
- 快照仅存有界数据；验证闭包的来源／Document 使用 WeakRef。归属与容器签名都是 WeakMap，未增加常驻强引用列表。每管理器仍为一个共享观察器，最多 128 条快照／在途提取。
- RenderValidity 不读取 ContextValidity。已发出 Prompt 保持不可变；原文、节点、owner、配置、路由和 generation 的拒绝条件保持原样。

## RED → GREEN 证据

在修改生产实现前先加入 24 项用例，**14 失败、10 通过**，原始证据为 [red-initial.json](evidence/hardening/red-initial.json)。标题回退依赖问题也在其对应修复前单独得到失败结果，见 [metadata-red.json](evidence/hardening/metadata-red.json)。

随后将完整 38 项矩阵放到未修改的 7321d6f9 生产代码上：**24 失败、14 通过**；最终 **38 全部通过**。其中 direct visibility:collapse 的旧隐私行为原本正确，该用例扩展版仅因旧代码不存在 styleReads 计数而失败，不能把它算成新增隐私漏洞。详细错误、阶段和最终结果见 [逐项账本](evidence/hardening/test-ledger.json)。

| 新增测试                                                                                              | 7321d6f9              | 最终  |
| ----------------------------------------------------------------------------------------------------- | --------------------- | ----- |
| P0-1: presentation class hover preserves the snapshot without projection                              | RED                   | GREEN |
| P0-1: presentation class bold preserves the snapshot without projection                               | RED                   | GREEN |
| P0-1: presentation class animation-frame-1 preserves the snapshot without projection                  | RED                   | GREEN |
| P0-1: 1000 decorative style changes never cause a projection or stale preparation                     | RED                   | GREEN |
| P0-1: presentation changes during parsing do not restart preparation                                  | RED                   | GREEN |
| P0-1: real text changes during parsing cannot publish old content                                     | GREEN（保留控制）     | GREEN |
| P0-1: a used meta content attribute expires only its actual consumer                                  | RED                   | GREEN |
| P0-1: unused body changes do not rebuild metadata-only context                                        | RED                   | GREEN |
| P0-1: CSS visibility changes hide and restore source without affecting unrelated scope                | GREEN（保留控制）     | GREEN |
| P0-1: links, source replacement and heading changes refresh the actual data                           | GREEN（保留控制）     | GREEN |
| P0-1: unrelated 1000 mutations and source reorder preserve the existing snapshot                      | GREEN（保留控制）     | GREEN |
| P0-2: collection affinity ends when a feed item becomes a standalone article                          | RED                   | GREEN |
| P0-2: last generic repeated item retains only its current container affiliation                       | RED                   | GREEN |
| P0-2: removing an explicit feed role can end affinity without moving the node                         | RED                   | GREEN |
| P0-2: moving between feeds and recycling source updates context but not unrelated items               | GREEN（保留控制）     | GREEN |
| P0-3: excludes private source under ancestor style="opacity:0"                                        | RED                   | GREEN |
| P0-3: excludes private source under ancestor style="content-visibility:hidden"                        | RED                   | GREEN |
| P0-3: excludes private source under ancestor inert                                                    | RED                   | GREEN |
| P0-3: excludes private source under ancestor style="visibility:collapse"                              | GREEN（保留控制）     | GREEN |
| P0-3: retains readable or accessible source under style="opacity:0.5"                                 | GREEN（保留控制）     | GREEN |
| P0-3: retains readable or accessible source under style="content-visibility:auto"                     | GREEN（保留控制）     | GREEN |
| P0-3: retains readable or accessible source under style="position:absolute;top:10000px"               | GREEN（保留控制）     | GREEN |
| P0-3: retains readable or accessible source under style="position:absolute;clip:rect(0,0,0,0)"        | GREEN（保留控制）     | GREEN |
| P0-3: a transparent shadow host cannot leak a nested source                                           | RED                   | GREEN |
| P0-2: 100 generic feed items survive deterministic reorder and deletion to one                        | RED                   | GREEN |
| P0-2: replacing a semantic feed container retains only proven current ownership                       | RED                   | GREEN |
| P0-2: normal standalone paragraphs do not imply a collection                                          | GREEN（保留控制）     | GREEN |
| P0-1: only explicitly referencing scopes follow a changed external quote                              | GREEN（保留控制）     | GREEN |
| P0-1: local shadow edits and visibility refresh only the acquired shadow scope                        | RED                   | GREEN |
| P0-1: asynchronous read interleaved with root replacement cannot cache detached content               | GREEN（保留控制）     | GREEN |
| P0-3: foreign-frame sources, controls and editable values are excluded; SVG and offscreen text remain | RED                   | GREEN |
| P0-3: direct opacity:0 hides only the private subtree and restoration is visible                      | RED                   | GREEN |
| P0-3: direct content-visibility:hidden hides only the private subtree and restoration is visible      | RED                   | GREEN |
| P0-3: direct visibility:collapse hides only the private subtree and restoration is visible            | RED（仅新增计数接口） | GREEN |
| P0-3: inert removal restores eligible source                                                          | RED                   | GREEN |
| P0-1: parser-sensitive class changes cannot be treated as presentation                                | GREEN（保留控制）     | GREEN |
| P0-1: removing a local heading registers the newly used document title                                | RED                   | GREEN |
| P0-3: an extension-owned shadow host cannot supply source context                                     | RED                   | GREEN |

## 跨功能与费用验证

- 完整 Vitest：**3069 通过、0 失败，337 个测试文件**。包含全文双语／纯译文、六段虚拟组、巨型段落、手动翻译、标题、划词弹窗、输入框、自定义操作，以及原文恢复、路由／后退前进、owner/config/DOM 所有权和缓存身份回归。使用 `SKIP_FREE_API=true` 排除真实外部免费服务测试。
- 这些入口共享快照层的修复；document-lifetime、render-guard、摘要准入和独立 owner 本轮未发现需修改的同源问题。字幕与独立 Hub 没有全页上下文失效依赖，保持其稳定实现。
- 本地真实 SDK／RequestQueue／BatchQueue／ResourceScheduler 对照：**4 → 4 HTTP，0 → 0 摘要 RPC**。A 等待、B 删除：1；缓存复读：0；两订阅者取消其中一个：1；明确 429 后成功：2。两版结束 active/queued/lanes/timers 均为 0。
- 真实 Chromium 原有 8 个场景：**28 → 28 HTTP**，包括两模式各 1/6/6 单元与各 1 个独立手动操作。六段场景先显示一段再删除 B，六段最终全部保留；关闭全文不取消独立手动操作。
- 新增两种模式的“等待时编辑 A”反向场景：每场景仅 1 次 HTTP，均拒绝旧译文，无自动重发。因此新浏览器报告总数是 **30**；新增的 2 次来自新增测试覆盖，不是同一工作负载多付了请求。
- 浏览器 1000 次装饰／无关帖子变更：新增正文投影 0、快照重建 0、stale 0、摘要 RPC 0、HTTP 0。普通观察与读取不启动 AI；新增隐私状态在真实 Chromium 下也经过隐藏／恢复验证。
- 两个浏览器页面各 100 个循环、1500 次获取后，Scope／Snapshot／在途准备／共享 work／Observer 均回到 0。单元容量测试还验证候选合并与显式重叠代际的容量二上界。

单元测试的本地投影／对象断言不冒充物理 HTTP 计数；RPC 计数来自消息 mock，HTTP 来自本地服务器实际接收数。浏览器 transport 不冒充原生扩展 IPC，SDK/队列由独立 fixture 验证。

## 性能与资源

[PERFORMANCE.md](PERFORMANCE.md) 提供四种语料各 20 次冷启动、七种 1000 次属性工作负载，以及 P50/P95、样本方差、DOM/style 调用、Long Tasks、CPU、JS heap、命中率和资源余额。

装饰类／样式的额外正文投影与重建从各 1000 降至 0；样式专项 CPU 从约 575ms 降至 185ms。同容器移动、真实文本变更仍要做新的资格验证，保留了相应开销。100 单元信息流冷 P95 为 **69.8 → 84.1ms**，整体 fixture CPU 中位数约 **0.131 → 0.167s**。这已触发本轮性能分析：新增验证、有限序列化与语义检查承担成本；重复容器签名计算已被减少，后者不能消除全部开销。

没有通过跳过安全校验压低数字。普通单文章冷 P95 100.5 → 95.7ms，热缓存 P95 基本不变；不能据此掩盖信息流回退。性能属于 CONDITIONAL 的明确后续条件：在目标机器重复当前矩阵，评估信息流启动与高频真实编辑的可接受预算，再做进一步采样优化；不宜在未验证前宣布全面性能验收完成。

## 隐私策略与未覆盖能力

明确排除 hidden、aria-hidden=true、inert、display:none、visibility:hidden/collapse、精确 opacity:0、content-visibility:hidden，以及控件／可编辑区域、脚本、嵌入 frame 和扩展 UI。检查祖先及 Shadow host；所有新增规则有正常内容保留／恢复控制。

保留非零 opacity、content-visibility:auto、正常屏幕外内容、clip/clip-path 无障碍文本、正常 SVG 文本。原有 translation-only 原始文本／属性恢复测试继续通过。

此策略不宣称识别所有 CSS 隐藏方式：CSSOM 写入、没有 DOM 记录的动画／媒体查询变化、外部关系选择器等可能不触发缓存候选验证。没有新增全页定时扫描；既有快照 TTL 为五分钟。先前已发出的 Prompt 不因后续隐藏而追溯变更。这些能力边界已写入 ARCHITECTURE 和 RISK_REGISTER。

## 命令结果与待验收

| 命令                                | 结果                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| `SKIP_FREE_API=true pnpm test`      | 3069 通过，exit 0                                       |
| `pnpm lint`                         | Oxlint + type-aware + type-check 通过，exit 0           |
| `pnpm fmt:check`                    | 通过，exit 0；1482 个文件                               |
| `pnpm exec wxt build -b chrome`     | Chrome MV3 生产构建通过，15.00 MB，exit 0               |
| `node e2e/context-engine/run.mjs …` | Chromium DOM + 本地 HTTP 通过，原 8 场景与 3 组新增检查 |
| `node e2e/mv3-preflight.mjs …`      | exit 2，明确 blocked-by-policy                          |

环境沿用已安装依赖，设置 `pnpm_config_verify_deps_before_run=false`，没有跳过类型或测试检查。文本日志仅规范化终端控制序列和行尾空白，保留诊断内容。日志及命令记录在 [evidence/hardening](evidence/hardening/commands.json)。现有 jsdom navigation、SDK schema compatibility 和构建 chunk size 警告保留在日志中，不等同于失败。

**仍待验收：** P1 原生 MV3 Worker 重启／IPC、真实 frame 注入、bfcache、弹窗与输入交互、多标签长时间运行；P2 目标机器上的信息流冷启动及真实编辑 CPU；P2 上述未观察到的 CSS 动态变化。管理策略 `/etc/chromium/policies/managed/extensions.json` 的 `ExtensionInstallBlocklist: ["*"]` 阻止扩展加载；未绕过策略，也未将普通 Chromium fixture 宣称为原生 MV3 通过。

截至本轮结束，没有发现所列已复现场景仍存在正确性、费用或资源生命周期阻断；条件项尚未完成，因此最终为 **CONDITIONAL**，不是正式生产发布通过。本地验收结束时，工作保留在目标分支且未自动推送。此后用户单独明确授权将代码推送至 `codex/subtitle-engine-v2`；该分支推送不改变 CONDITIONAL 验收结论，不包含 PR、Actions 或版本发布。

# Read Frog Lite 功能恢复审计与计划

原版：v1.54.1，`aa6d54d1b9fde901fa7dbc00540a196fd28cd388`。Lite 0.1.0 基线：`11956229`。工作分支：`codex/read-frog-independent`，保留 `codex/read-frog-lite`。本分支不向官方扩展发布，因此不创建上游 release changeset。

## Phase 0：恢复矩阵

下列路径均为原版仓库 `src/` 下的真实实现，已检查源码、导入和服务边界。恢复采用逐项文件清单，避免目录级未经审计的覆盖。

| 功能                                            | 上游路径                                                                                                                                                           | Lite 状态            | 恢复方式与边界                                                                                                | 原始测试                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 网页/双语/仅译文/恢复/悬停段落                  | utils/host; entrypoints/content-runtime/host                                                                                                                       | 保留                 | 保留现有引擎、调度与快捷键                                                                                    | host/translate 下测试                            |
| 输入翻译                                        | entrypoints/content-runtime/selection/input-translation; entrypoints/input-injector.content; options/pages/input-translation（实际位于 entrypoints/options/pages） | 删除                 | 恢复 triple-space hook、编辑器桥接；移除事件分析和 Hosted 错误分支                                            | input-injector.content/**tests**/lexical.test.ts |
| 浮动工具                                        | entrypoints/content-runtime/side; entrypoints/options/pages/floating-button                                                                                        | 删除                 | 恢复拖动、点击、长按、状态；不接回账户入口                                                                    | floating-button/**tests**/index.test.tsx         |
| 本地术语表                                      | utils/glossary; background/glossary.ts; db/dexie/tables/glossary*.ts                                                                                               | 删除                 | 恢复本地 CRUD、CSV、匹配、Prompt/缓存键集成；排除 analytics、sync 和同步快照                                  | glossary/**tests** 的本地测试                    |
| 自定义 AI Actions                               | options/pages/custom-actions（entrypoints 下）; types/config/selection-toolbar.ts; utils/custom-actions.ts                                                         | 仅内置词典和句子分析 | 恢复独立 action 编辑/顺序/快捷键/输出 schema；不恢复 Notebase、专有 layout-engine                             | custom-actions/toolbar 项目测试                  |
| 翻译中心                                        | entrypoints/translation-hub                                                                                                                                        | 删除                 | 恢复多 Provider 文本翻译；去 Hosted/分析，TTS 在 Phase 3 接回                                                 | prompt、card、input 测试                         |
| YouTube/Netflix/X 字幕                          | entrypoints/subtitles.content; utils/subtitles; main-world 注入器                                                                                                  | 删除                 | 恢复原生获取、调度、翻译、显示、导出、缓存。X 原实现为原生 TextTrack，无需 ASR                                | fetcher/parser/scheduler/export/coordinator 测试 |
| 字幕词典/暂停辅助                               | subtitles.content/learning                                                                                                                                         | 删除                 | 这是翻译辅助，保留查词/按住暂停；只移除 Notebase 按钮                                                         | learning 下独立测试                              |
| 官方 AI 视频转录                                | utils/subtitles/ai; fetchers/ai                                                                                                                                    | 删除                 | 原版以 URL 提交官方任务、账户配额与轮询，不能直接用于音频 Blob；不恢复官方 transport/guard                    | 仅恢复无官方依赖的数据/取消逻辑测试              |
| TTS 播放主体                                    | hooks/use-text-to-speech.tsx; utils/tts-playback; background/tts-playback.ts; offscreen                                                                            | 删除                 | 恢复分段、预取、请求替换/停止、offscreen 播放；使用用户 Speech 配置替换 Edge transport                        | hook/controller/background 测试                  |
| TTS 服务                                        | utils/server/edge-tts                                                                                                                                              | 删除                 | 原版没有独立浏览器 SpeechSynthesis；不恢复 Edge 在线请求。现有 AI SDK 支持 OpenAI speech，用小型 adapter 连接 | 新增协议与响应安全测试                           |
| ASR 服务                                        | 原版官方视频 URL job，不是音频输入协议                                                                                                                             | 删除                 | 复用现有 AI SDK transcription，最小音频输入/取消/响应规范化接口；不实现捕获或模型部署                         | 新增协议、时间戳和取消测试                       |
| 账户/订阅/Hosted/Notebase/FSRS/云同步/运营/遥测 | auth、server、商业和学习模块                                                                                                                                       | 删除                 | 持续排除                                                                                                      | 网络隔离回归                                     |

## 依赖与许可证决策

- 原始 GPLv3 仓库源文件及测试可复用，保留 LICENSE/归属。
- `@read-frog/layout-engine` 独立限制不明：不恢复、不复制其实现；自定义 Action 使用已有 GPL 输出字段渲染器。
- `@read-frog/definitions@0.11.0` 元数据未提供许可证；元数据指向的独立 monorepo LICENSE 和包 LICENSE 查询返回 404。不能据此确认授权；最终清理阶段将使用明确许可的 ISO 语言数据和 GPL 仓库语言映射替代，不能复制该包实现。
- 现有 `@ai-sdk/openai` 已提供 speech/transcription 模型，`ai` 已提供 generateSpeech/transcribe；不另造标准 HTTP 客户端。
- 独占依赖仅在恢复模块实际导入时加入。新增 offscreen 权限仅用于音频播放，不申请录音、tabCapture 或 microphone。

## 基线验证（修改前）

- oxlint --type-aware --type-check：通过（类型与 Lint）。
- SKIP_FREE_API=true vitest run：173 文件、1830 测试通过，60.01 秒。
- wxt build：Chromium MV3 生产构建通过，5.166 秒，8,020,047 字节。
- 源码 621 文件、3,733,210 字节；直接依赖 runtime 54 / dev 34；已有 ZIP 2,546,305 字节。
- 原版基线：源码 1592 文件、12,898,408 字节；依赖 93 / 41；生产构建 20,452,994 字节。
- 此云环境此前 Chromium 明确拒绝加载 unpacked 扩展（administrator policy）。不绕过策略；最终仍尝试合法浏览器验证，并准备 GitHub Actions 扩展 E2E 与人工验收。

## 执行顺序

0. 审计与基线（本提交）。
1. 输入、浮动、本地术语表、自定义 Actions 和独立辅助功能。
2. 原生视频字幕系统与测试，移除官方转录链。
3. 原 TTS 播放主体和 SDK 语音/转录边界。
4. 复用原 Provider 设置和按功能选择机制，完成能力配置。
5. 网络/许可证/依赖/权限审计、回归、CI ZIP artifact 与真实浏览器验收；具备权限时推送到用户 Fork 并建 PR，不合并、不发布。

每阶段独立本地提交；构建和测试失败先区分原版差异与实际回归。真实平台/真实模型未测内容须明确保留，不能由单元测试代替。

# Phase 4：统一能力配置

扩展原 Provider Registry、FEATURE_PROVIDER_DEFS、useFeatureProvider 和 ProviderSelector，新增 tts/transcription 两个独立能力选择。OpenAI 与 OpenAI-compatible 行可被音频能力选择，Google/Ollama 文本 SDK 不被误当成音频协议。用户仍在同一处管理名字、Base URL、API Key、请求头；音频模型、语音、语速、格式、语言和超时存入本地配置。

恢复原语音设置页面、语言选择/预览/重置和带草稿的语速输入；来源见 phase4-files.json。Edge 专属语音目录换为用户服务定义的 Voice 文本输入，不提供未经测试的模型/Voice 列表。OpenAI Speech 协议不支持原 Edge 的 pitch/volume 字段，因此不恢复这两个无效设置。ASR 设置明确标注只配置接口，没有捕获/自动转录入口。

安全和可维护性修复：配置允许未选择服务或零 Provider；删除 Provider 后原按功能配置与 Action 选择清空，写入同一次本地更新，不自动选另一服务。禁用的已保存 Provider 不导致整份配置回退重置，但 Registry 拒绝调用它。现有 UI 仍要求先解除功能占用再停用。旧配置新增音频字段为空，原有 Key/语言保持不变，schema 升到 4。

验证：23 文件 / 81 项配置、Provider、音频及已有 API 设置测试通过，含服务删除、空 Provider、能力过滤、独立模型选择、禁用与旧配置迁移。全量 256 文件 / 2534 项执行，旧的“禁用 Provider 应使配置无法读取”断言调整为保留配置且运行时拒绝；其余通过。类型/lint 与 Chromium 构建通过（约 14 MB）。最终阶段补充实际浏览器与全量检查。

# Phase 3：语音播放、音频接口及翻译中心

原版来源与逐文件导入审计见 phase3-files.json。另恢复原 GPL 页面容器、工具栏 speak 分支、朗读开关、翻译中心快捷键。来源均为 aa6d54d1b9fde901fa7dbc00540a196fd28cd388。

直接复用：DOMAudioPlaybackController、Chrome offscreen 创建/复用/唤醒重试、播放结束/错误/停止清理、旧请求替换保护、UTF-8 分段（1800 字节 / 最多 60 段）、音频队列、相邻段预取、内存缓存、语言选择、划词/原文/翻译中心朗读入口。移除遥测。分段算法从 utils/server/edge-tts/chunk.ts 移至 utils/tts-playback/chunk.ts，仅常量与错误类型改为本地音频类型。

原版没有暂停后继续的独立 API，也没有浏览器 SpeechSynthesis 实现，本阶段没有重写播放器补造这两项。保留停止/再次播放。原 TTS 的 Edge 在线获取与公共签名常量没有恢复。

新增最小音频适配的理由：原 TTS 固定使用 Edge 服务，原 ASR 是官方视频 URL 任务，均不能表达用户服务的标准音频接口。新 types.ts 定义 SpeechProvider / TranscriptionProvider，openai-audio.ts 使用现有 @ai-sdk/openai 的 speech/transcription 模型 API，不手写 multipart 或另建插件框架。端点/API Key/请求头复用现有 Provider 行，音频模型与参数独立。本地 HTTP、局域网与 HTTPS 均允许。

请求有显式服务选择、取消、超时、25 MiB 输入/响应上限、MIME/SDK JSON/schema 校验、时间范围校验、Cookie 排除和重定向拒绝。错误不透出 SDK 请求体/服务响应。TTS 在 background 读取配置，播放内容传给 offscreen，不把 API Key 发送到页面 DOM。配置指纹确保设置变动后不把旧缓存身份与新服务混用。

ASR 接口接受 Blob / MIME / 可选语言 / AbortSignal，返回文本及可选片段；秒转换成原字幕模型的毫秒，加入可选 id / sourceLanguage。不伪造无时间戳响应的时间。没有视频音频捕获、模型部署或实时 ASR；因此 ASR 尚无网页触发入口，接口本身有真实 SDK 协议测试。

Translation Hub 恢复原语言/Prompt/多服务选择、独立输出卡片、术语、错误重试、复制和朗读。移除 Hosted 分支及帮助推广。未保存多服务选择时只使用用户当前页面翻译 Provider，防止一次翻译向所有预置服务发送文本。

专项验证：9 文件 / 48 测试通过，包含本地 HTTP 端点上 13 个音频协议测试。类型/lint 和 Chromium 生产构建通过。真实播放设备与真实模型部署尚未验证；Phase 4 接入配置界面，Phase 5 做浏览器验收与全量审计。

全量阶段执行 255 文件 / 2528 测试，13 个失败来自旧测试没有挂载新增朗读上下文（12）与原文布局测试未隔离 SpeakButton（1）。补齐测试装配后相关测试复验；host runtime 也复验通过。新音频请求取消测试暴露了 Blob 读取期间取消后的 SDK multipart 创建问题，已在读取完成后再检查 AbortSignal，避免发送已取消请求。

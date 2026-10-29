# Read Frog Lite 0.2.2

本版修复 DeepSeek 词典 / 长难句请求的格式不兼容，并修复残留的青蛙 Logo 跨源加载路径。

## 修改

- 新增专用 DeepSeek Provider，复用官方 Read Frog 使用的 `@ai-sdk/deepseek`，锁定 3.0.63。它为结构化请求发送 `json_object`，将字段结构要求加入提示词；扩展继续执行原有输出校验、流式显示与取消逻辑。没有手写替代协议或遇错切换其他服务。
- 支持配置 Key、Base URL 和模型；自定义模型模式可获取模型列表。标准 DeepSeek 根地址和 `/v1` 的旧 Custom Chat Complete 配置在版本 5 初始化时自动转换，保留 ID、实际模型、凭据及功能引用。其他地址不自动转换。
- 字幕翻译按钮、网页悬浮按钮的内置 PNG 都改为 data URL。前版已修复的 Provider SVG 和离线操作图标继续保留。
- 运行失败仍仅输出脱敏 DevTools 诊断，不恢复前端红色错误框。
- 已有 OpenAI 专用 SDK 保持 Responses + JSON Schema 路径，补充实际 SDK 请求序列化的回归检查；不将 OpenAI 降级为 JSON mode。

## 开源与费用

新增包采用 Apache-2.0，SDK 本身免费；DeepSeek API 调用费用由 DeepSeek 收取。调用直接到用户配置地址，无 Read Frog / Vercel 中转费用、账户或额度检查。新增直接运行依赖 1 个，底层 provider / provider-utils / zod 复用现有版本。

包版权声明收录在 `THIRD-PARTY-NOTICES.txt`，Apache-2.0 全文在 `APACHE-2.0-LICENSE.txt`；项目仍保留 GPLv3 和原作者归属。

来源：[SDK 3.0.63 包声明](https://cdn.jsdelivr.net/npm/@ai-sdk/deepseek@3.0.63/package.json)、[适配器源码](https://cdn.jsdelivr.net/npm/@ai-sdk/deepseek@3.0.63/src/chat/deepseek-chat-language-model.ts)、[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。

## 安装与人工复核

下载 Release 附件 `read-frog-lite-0.2.2-chrome.zip`，覆盖原扩展目录，重新加载扩展并确认版本 0.2.2，再刷新 YouTube。不要卸载扩展或清空配置。

检查原来 deepseek-flash 配置的类型已变为 DeepSeek，模型和 Key 仍在，词典 / 长难句仍绑定同一服务。分别测试普通网页和 YouTube 字幕选词，再检查字幕按钮 Logo。若仍失败，F12 Console 过滤 `[Read Frog Lite][stream]`，提供该行 JSON；不要发送 Key 或完整网络记录。

测试使用真实 SDK 与本地受控响应，不调用用户账户的付费 API。真实 DeepSeek 服务、YouTube 和用户具体浏览器环境仍需上述人工验证。SDK 的 JSON Schema compatibility 警告表示它在使用提示词约束结构，本身不代表请求失败。

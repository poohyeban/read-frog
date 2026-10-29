# Read Frog Lite 0.2.1

本版修复划词操作图标和 Provider 图片，并为词典 / 长难句分析的失败增加生产环境 DevTools 诊断。尚未更改 DeepSeek 请求协议；请用本版复现后提供诊断日志。

- 修复词典、长难句分析、写作改进图标空白，兼容已有设置，使用随包附带的离线图标。
- 内置 Provider SVG 改为 data URL，避免在 YouTube 等页面加载扩展图片 URL。
- 词典 / 长难句运行失败不再显示红色错误框。重试及缺少 Provider 等配置提示保留。
- 页面与后台控制台记录相同请求编号、HTTP 状态、输出格式、已识别的错误类别和连接阶段。不会记录 Key、鉴权头、完整 URL、请求正文、选中文字或原始服务端错误。
- 读取端口断开时的 runtime.lastError，并清理发送失败后的监听器及定时器。取消和正常完成不记录错误。

## 安装与复现

下载本页的 `read-frog-lite-0.2.1-chrome.zip`，解压后按 README 更新已加载扩展的目录；在 `chrome://extensions` 点击重新加载，确认版本为 0.2.1，再刷新 YouTube。

按 F12 → Console，开启 Preserve log，过滤 `[Read Frog Lite][stream]`，选词并打开词典或长难句分析。复制该前缀后的 JSON。如果页面没有此日志，打开扩展卡片的 Service worker → Inspect，再复现一次并复制相同前缀日志。不要发送整个 Network / HAR 或配置导出。

## 已知边界

官方专用 DeepSeek 适配器默认使用 `json_object`；Lite 的通用 Chat Complete 沿用了官方通用适配器的 `supportsStructuredOutputs: true`，结构化操作发送 `json_schema`。这是当前最明确的兼容性差异，真实失败状态仍需用户复现日志确认。本版不声称已修复 DeepSeek 的词典请求，也未使用用户密钥访问真实服务。

源码对照、日志字段和验证说明见 `docs/restore/DIAGNOSIS-ACTION-ICONS.md`。`SHA256SUMS.txt` 对应经过 CI 检查的发布 ZIP。

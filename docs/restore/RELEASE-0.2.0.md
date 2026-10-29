# Read Frog Lite 0.2.0

[直接下载扩展 ZIP](https://github.com/poohyeban/read-frog/releases/download/v0.2.0/read-frog-lite-0.2.0-chrome.zip) · [下载 SHA256 校验文件](https://github.com/poohyeban/read-frog/releases/download/v0.2.0/SHA256SUMS.txt)

基于 Read Frog v1.54.1 的独立 Chromium MV3 翻译扩展。无需 Read Frog 账户、订阅或官方云服务；使用用户自己的 API / 本地服务，没有遥测或隐式在线备用服务。

## 下载与安装

1. 下载附件 **`read-frog-lite-0.2.0-chrome.zip`**。GitHub 自动生成的 `Source code` 是源码，不是扩展安装包。
2. 解压 ZIP，将目录保存到固定位置。
3. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`，开启开发者模式，选择“加载已解压的扩展程序”。
4. 选择直接包含 `manifest.json` 的目录，打开设置配置自己的 Provider，然后刷新网页。

不需要在个人电脑编译。升级已有安装时完整替换原目录中的文件，保持路径 / 扩展 ID，在原扩展条目点击重新加载；升级前备份配置和术语表，不要卸载重装。

## 本版功能

- 原网页翻译引擎：双语、仅译文、原文恢复、动态页面、划词与悬停翻译。
- 恢复输入翻译、浮动按钮、本地术语表、自定义 AI Actions、翻译中心。
- 恢复 YouTube / Netflix / X 原生字幕翻译、同步显示、样式和 SRT 导出。
- 恢复 TTS 队列、分段、预取、停止与 offscreen 播放，使用用户选择的 OpenAI-style Speech 服务。
- 提供独立 ASR 配置及真实 OpenAI-style Transcriptions Adapter。
- 文本服务支持 OpenAI、OpenAI-compatible、Google Gemini、Ollama，允许 localhost / 局域网端点。

## 验证与限制

类型 / Lint、2544 项单元及协议测试、Chromium 生产构建和真实浏览器核心流程回归均已通过。[完整 CI](https://github.com/poohyeban/read-frog/actions/runs/40827815730)。此 ZIP 直接来自已验证的 CI 产物，发布时没有重新编译。

真实视频平台的当前页面、复杂编辑器、实际音频设备和具体模型部署仍需人工验收。没有视频音频捕获、无字幕视频自动 ASR、实时转录或内置模型部署。TTS 支持停止 / 再播放，没有独立暂停后继续操作。显示模式影响下一次翻译，切换后需关闭再开启。

## 校验与源码

- ZIP：4,598,062 字节。
- SHA256：`c4686e909cb6cfb8cd753ec9e7972648f759981691944ca131dcaf429063af90`，另附 `SHA256SUMS.txt`。
- [使用及开发说明](https://github.com/poohyeban/read-frog/blob/v0.2.0/README.md)
- [完整恢复报告](https://github.com/poohyeban/read-frog/blob/v0.2.0/docs/restore/REPORT.md)
- [人工验收步骤](https://github.com/poohyeban/read-frog/blob/v0.2.0/docs/restore/MANUAL-ACCEPTANCE.md)

保留 Read Frog 作者及 contributors 归属，遵循 GPLv3；ZIP 内含 LICENSE、NOTICE 和第三方许可证通知。对应源码可通过本 Release 的 Source code 下载。本版并非 Read Frog 官方发行版。

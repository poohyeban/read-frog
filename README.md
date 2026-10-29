# Read Frog Lite 0.2.0

基于 [Read Frog v1.54.1](https://github.com/mengxi-ream/read-frog/tree/aa6d54d1b9fde901fa7dbc00540a196fd28cd388) 的独立 Chromium Manifest V3 翻译扩展，与官方发行版无关。

保留原网页翻译引擎，恢复输入翻译、浮动按钮、本地术语表、自定义 AI Actions、翻译中心、YouTube / Netflix / X 原生字幕翻译和语音播放。无需 Read Frog 账户、订阅或官方云服务，没有遥测、Notebase、云同步、FSRS 或 Edge 在线 TTS。

文本支持用户配置 OpenAI、OpenAI-compatible、Google Gemini、Ollama。TTS 采用 OpenAI Speech 协议；ASR 提供真实的 OpenAI Transcriptions SDK 适配和配置边界，**尚未实现视频音频捕获或网页自动转录入口**。Piper、Kokoro、faster-whisper 的具体部署需要符合相应协议，不能仅凭模型名称判断兼容。

## 获取安装包

在本 Fork 的 [Actions](https://github.com/poohyeban/read-frog/actions/workflows/pr-test.yml) 中打开开发分支的运行记录，下载 `read-frog-lite-chromium-<commit>` Artifact。解压 Artifact，再解压其中扩展 ZIP。在 `chrome://extensions` 或 `edge://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，定位包含 `manifest.json` 的目录。**不需要在个人电脑编译源码**。

Artifact 在 Chromium 构建成功后上传；浏览器 E2E 随后运行，因此有 ZIP 不代表所有测试均已通过，请同时查看 CI 状态。产物保留 30 天。没有自动合并或发布商店 / Release。

## 配置自己的服务

1. 在 API Providers 中填写端点、API Key、模型；自建 Chat Completions 服务使用 OpenAI-compatible。Base URL 例如 `http://127.0.0.1:8000/v1`，不要重复填写 `/chat/completions`。
2. 在各功能 Provider 设置中分别选择网页、划词、输入和字幕翻译服务。没有内置免费服务或自动网络回退。
3. 朗读需要单独选择 Speech Provider、音频模型和 Voice。支持 MP3/WAV、语速和按语言选择 Voice；参数必须由目标服务支持。
4. Transcription 设置只配置音频接口；未配置时不会请求官方服务器。

默认不自动翻译站点或视频。页面翻译 `Alt+E`、显示模式 `Alt+Shift+M`、划词翻译 `Alt+T`、输入框连按三次空格、翻译中心 `Alt+Shift+H`；均可在原设置界面调整。

配置存于本地 `readFrogLiteConfig`，Dexie 缓存 / 术语表在 `ReadFrogLiteDB`。从 Lite 0.1 升级保留原配置，新增音频服务默认为空；不导入官方账户数据。密钥只在扩展设置中填写，不使用构建环境变量。凭据请求拒绝重定向，HTTP 本地 / 局域网服务可配置。

## 开发验证

Node.js >=24，pnpm 12.10.1：

```sh
pnpm install --frozen-lockfile
pnpm lint
SKIP_FREE_API=true pnpm test --maxWorkers=4
pnpm zip
pnpm exec playwright install chromium
xvfb-run --auto-servernum pnpm test:e2e
```

浏览器测试需要允许加载 unpacked 扩展的环境；不要绕过管理员策略。[完整恢复报告](docs/restore/REPORT.md) · [手动验收](docs/restore/MANUAL-ACCEPTANCE.md) · [阶段记录](docs/restore/PLAN.md) · [实际指标](docs/restore/final-metrics.json)。旧的减法报告保留在 `docs/lite/`，描述 0.1.0，不能代替当前状态。

## 来源与许可证

原项目由 [Mengxi](https://github.com/mengxi-ream) 及 Read Frog contributors 开发，保留原 Git 历史、版权与 [GPLv3](LICENSE)。修改版源码和 ZIP 同时提供许可证与第三方通知。

`@read-frog/definitions` 因无法确认独立包许可证已移除；语言列表来自 GPL 仓库本地化，ISO 映射由 MIT `iso-639-3` 与 ICU/CLDR 标准别名生成，没有复制该包实现。`@read-frog/layout-engine`、`@read-frog/api-contract` 也不依赖。见 [LICENSES](LICENSES) 和 `public/THIRD-PARTY-NOTICES.txt`。

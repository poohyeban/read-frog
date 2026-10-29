# Read Frog Lite

基于 [Read Frog](https://github.com/mengxi-ream/read-frog) 的私人 Chromium Manifest V3 翻译扩展。保留原有网页翻译引擎、双语/仅译文模式、原文恢复、划词翻译，以及词典和句子分析。

仅支持用户自行配置 OpenAI、OpenAI-compatible API、Google Gemini 和 Ollama。没有账户、订阅、官方 Hosted AI、云同步、字幕、笔记、朗读或遥测。首次使用必须配置自己的服务；没有内置免费翻译接口。默认不自动翻译任何站点。

## 构建与加载

使用 Node.js >=24、pnpm 12.10.1：

```sh
pnpm install --frozen-lockfile
pnpm lint
SKIP_FREE_API=true pnpm test
pnpm build
```

在 `chrome://extensions` 或 `edge://extensions` 开启开发者模式，加载 `.output/chrome-mv3`。打开扩展设置，填写 API Key、Base URL、模型，并为网页翻译、划词翻译和 AI 解释选择 Provider。API Key 只在扩展本地配置中填写，不使用构建环境变量。

扩展采用独立的 `readFrogLiteConfig` 和 `ReadFrogLiteDB`，不迁移官方扩展的配置或账户数据。自定义 API 必须使用最终端点地址；携带凭证的请求拒绝 HTTP 重定向。

[完整删减报告与手动验收步骤](docs/lite/REPORT.md) · [基线与阶段记录](docs/lite/PLAN.md) · [实测指标](docs/lite/final-metrics.json)

## 来源与许可证

这是 Read Frog 的修改版本，与官方发行版本无关。原项目由 [Mengxi](https://github.com/mengxi-ream) 及 Read Frog contributors 开发；原始 Git 历史和作者归属保留。项目继续遵循 [GNU GPLv3](LICENSE)，第三方依赖遵循各自许可证。离线 Tabler 图标的 MIT 许可证见 [LICENSES/tabler-icons.txt](LICENSES/tabler-icons.txt)。保留的 `@read-frog/definitions` 包缺少明确的包内许可证元数据，详见报告中的来源核查限制。

本次仅创建本地开发提交和构建产物，没有推送仓库或发布扩展。

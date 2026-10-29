# v0.2.0 字幕选词 / AI Actions 定位记录

后续：用户在 0.2.1 捕获到实际 HTTP 400 / invalid_request_error / json_schema；0.2.2 已接入专用 DeepSeek 适配器，并修复剩余 PNG 路径。见 [0.2.2 修复说明](RELEASE-0.2.2.md)。以下保留诊断过程与证据边界。

用户报告：YouTube 字幕选词打开词典后失败；刷新仍失败；普通网页的词典和长难句分析也失败。配置为自定义 Chat Complete、`https://api.deepseek.com`、`deepseek-flash`。同时出现 Provider SVG 跨源加载警告、后台连接错误及内置 Action 图标空白。

本次范围：按用户后续要求修复图标与图片，并在 0.2.1 增加 DevTools 诊断、去掉 Action 运行错误框。AI 请求协议暂不修改，等待真实日志；不覆盖 v0.2.0 Release。

## 1. 词典与长难句分析的协议不匹配

字幕 `learning/atoms.ts` → `CustomActionPanel` → `useCustomActionExecution` → `stream-structured-object` → background `Output.object` → OpenAI-compatible SDK。

`src/utils/providers/model.ts` 对兼容服务固定设置 `supportsStructuredOutputs: true`。实际 SDK 请求会包含 `response_format.type = json_schema` 和 `strict = true`。DeepSeek 官方 Chat Completions 契约的 response_format 只接受 text / json_object；官方 JSON Output 示例也使用 deepseek-flash 与上述 Base URL。因此这套配置与当前 Action 请求存在明确协议不匹配，不应归因于用户模型名称填错。

- [DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)

使用项目已安装 SDK 和本地 HTTP 诊断端点验证：普通流式文本请求没有 response_format，可成功返回；同一模型的 Output.object 请求发送 json_schema，模拟不支持该格式的服务返回 400。没有调用用户真实 API 或索取 Key，因此没有声称捕获到用户那次请求的 HTTP 状态。

## 2. 通用错误提示掩盖细节

后台 `background-stream.ts` 先将状态码转为安全错误文字；消息经 `StreamPortError` 包装后不再含 statusCode。前台 `inline-error.ts` 再调用 `extractAISDKErrorMessage`，只认 statusCode，于是已有安全文字也被改成 Unexpected error occurred，最终显示“自定义操作请求失败”。本地直接执行当前函数已确认这条信息丢失链。

`Could not establish connection. Receiving end does not exist` 是扩展消息接收端问题，与 HTTP 400 不是同一个错误。`port-streaming.ts` 的 onDisconnect 把原因统一转成 Stream disconnected unexpectedly，也未读取 runtime.lastError。后台源码确实同步注册了两个流端口，不能凭这一条没有调用栈的日志断定监听器被删、服务工人崩溃或模型故障；这部分还需对应时刻的后台日志 / 端口信息。

## 3. 图标与图片修复

- 内置词典、长难句、写作改进使用 streamline-color 名称，但本地生成器只收集 Tabler / ri / garden 名称。offline Icon 无法解析，导致占位而不显示。生成器现为三个旧名称注册 MIT Tabler 图形，兼容已有本地配置，无需用户重建 Action，不连接 CDN。
- Provider 图片仍使用 chrome-extension://.../assets/custom-provider-_.svg。用户给出的 Qf / Sl 堆栈均对应 React 设置 img src；发布包中图片存在且 manifest 已开放 assets/_.svg，不能简单判为漏配资源权限。现将该受信任的内置 SVG 在构建时内嵌为 data URL，消除这条扩展 URL 图片请求。未声称已经在用户的 YouTube 会话复现浏览器拒绝条件。

回归检查使用真实 offline Icon 渲染三个内置 Action；浏览器 E2E 增加对 Provider 图片 data URL、complete 和 naturalWidth 的断言。v0.2.0 原浏览器测试覆盖普通文本翻译，未覆盖词典结构化协议；原字幕卡片单元测试还替换了 CustomActionPanel，因此原 CI 通过不代表这条实际业务链已经验证。

## 4. 官方源码对照（2026-10-29）

对照 Lite 的基线 `aa6d54d1b9fde901fa7dbc00540a196fd28cd388` 及官方 main `878e18d488020aad5437a96041f577f89f98bd74`：

- [官方 model.ts](https://github.com/mengxi-ream/read-frog/blob/878e18d488020aad5437a96041f577f89f98bd74/src/utils/providers/model.ts) 为 `deepseek` 注册 `createDeepSeek`。通用兼容类型则设置 `supportsStructuredOutputs: true`，与 Lite 相同。
- 官方依赖 `@ai-sdk/deepseek ^3.0.63`。核对 npm 发布的 3.0.63 源码：[provider factory](https://cdn.jsdelivr.net/npm/@ai-sdk/deepseek@3.0.63/src/deepseek-provider.ts) 未开启 `supportsStructuredOutputs`；[chat model](https://cdn.jsdelivr.net/npm/@ai-sdk/deepseek@3.0.63/src/chat/deepseek-chat-language-model.ts) 仅当该能力显式为 true 时发送 json_schema，否则发送 json_object。[消息转换](https://cdn.jsdelivr.net/npm/@ai-sdk/deepseek@3.0.63/src/chat/convert-to-deepseek-chat-messages.ts) 在不支持结构化输出时将 JSON 格式要求加入提示词。并非只改 response_format 一个字段。
- [官方 background-stream.ts](https://github.com/mengxi-ream/read-frog/blob/878e18d488020aad5437a96041f577f89f98bd74/src/entrypoints/background/background-stream.ts) 的用户自配服务同样调用 Output.object；差异发生在具体 Provider SDK 的序列化阶段，不需要官方账户或 Hosted AI 才能调用。
- [官方错误提取](https://github.com/mengxi-ream/read-frog/blob/878e18d488020aad5437a96041f577f89f98bd74/src/utils/error/extract-message.ts) 会返回原始 message / responseBody / text。Lite 不能直接恢复这种行为，因为自定义服务可能在错误中回显凭据或私密文本。

因此，官方选择专用 DeepSeek 时有明确的协议适配优势；不能断言官方选择“自定义 Chat Complete”并使用完全相同配置也一定成功，更不能将本地模拟的 HTTP 400 当成用户真实响应。

## 5. 0.2.1 开发者诊断

错误前缀统一为 `[Read Frog Lite][stream]`，发布构建也有效；普通 dev logger 仍在生产关闭。只在实际失败时写本地 console，不持久化、不上传、不增加网络请求。

| 字段                      | 含义                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| diagnosticVersion / scope | 日志格式版本；background 或 content                                                                                |
| requestId / port          | UUID 关联同一次请求；文本或结构化输出端口                                                                          |
| phase                     | connect / send / start / request / disconnect                                                                      |
| httpStatus / errorType    | 原始错误及 cause 链中的 HTTP 状态与允许的错误类名                                                                  |
| responseFormat            | SDK 失败对象中的实际 text / json_object / json_schema；缺失则不猜测                                                |
| providerCode / parameter  | 服务端 code、type、param 的固定白名单；未知值省略                                                                  |
| reason                    | 固定分类，例如 response_format_rejected、no_receiver、context_invalidated、network_error、output_validation_failed |

日志不包含原始异常、堆栈、响应正文、Key、headers、URL、模型自定义标签、Prompt 或选中文字。服务端消息只用于识别固定类别，不复制原文。跨端口转发的诊断再次校验并去掉额外字段。HTTP 状态与 JSON Schema 同时出现仍只是定位证据，不自动触发协议回退。

复现方法：更新扩展并刷新网页 → F12 Console → Preserve log → 过滤上述前缀 → 执行词典 / 长难句。复制该行 JSON；必要时在 chrome://extensions 的 Service worker 控制台补充相同 requestId 的行。`no_receiver` 表示这个流端口未找到接收端，不代表已证明所有未检查 runtime.lastError 都来自本模块。

自动化覆盖：真实已安装 AI SDK + 本地 fetch 响应模拟 HTTP 400 / JSON Schema 拒绝；秘密回显不泄漏；cause 循环；端口连接/发送/断开及清理；取消/成功不报错；Action 失败无红框且可重试。浏览器 E2E 使用本地 HTTP 服务触发词典和长难句的真实后台 SDK 400，检查页面 DevTools 日志和无错误框。真实 YouTube、DeepSeek 服务和用户现有配置仍需用户复现。

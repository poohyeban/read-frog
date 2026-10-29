# v0.2.0 字幕选词 / AI Actions 定位记录

用户报告：YouTube 字幕选词打开词典后失败；刷新仍失败；普通网页的词典和长难句分析也失败。配置为自定义 Chat Complete、`https://api.deepseek.com`、`deepseek-flash`。同时出现 Provider SVG 跨源加载警告、后台连接错误及内置 Action 图标空白。

本次范围：按用户后续要求修复图标与图片；AI 请求及错误处理仅定位，不修改，不覆盖 v0.2.0 Release。

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

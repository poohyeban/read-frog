# Read Frog Lite 删除计划与基线

任务日期：2026-10-29。独立本地分支：`codex/read-frog-lite`。禁止 push / 发布。

基线：`aa6d54d1b9fde901fa7dbc00540a196fd28cd388`，v1.54.1。工作区预置 clone 的 origin 为 `https://github.com/poohyeban/read-frog.git`，任务指定上游为 `https://github.com/mengxi-ream/read-frog`。以检查过的本地 SHA 为比较基准，保留 GPLv3 与作者归属。原始指标见 `baseline.json`。

## 架构与删除边界

```mermaid
flowchart LR
  Popup[Popup / Options] --> Config[本地配置 / Jotai / Zod]
  Content[Content loader / runtime] --> DOM[DOM 检测、分段、观察、恢复]
  DOM --> Queue[Background 翻译队列]
  Selection[划词工具栏 / AI 解释] --> Stream[Background 流式 AI]
  Queue --> Provider[Provider Registry / AI SDK / 普通翻译 API]
  Stream --> Provider
  Queue --> Cache[Dexie 翻译缓存]
  Provider --> UserAPI[用户指定端点]
  Provider -.删除.-> Hosted[官方 Hosted AI / oRPC]
  Hosted -.删除.-> Auth[账户 / Session / Billing]
```

| 分类   | 模块                                                      | 理由 / 边界                                     |
| ------ | --------------------------------------------------------- | ----------------------------------------------- |
| KEEP   | `utils/host`、`content-runtime/host`、iframe 注入         | 复用 DOM 翻译、动态网页和恢复逻辑               |
| KEEP   | Popup、Options 的语言/API/模式/快捷操作                   | 核心配置与触发入口                              |
| KEEP   | 用户 Provider、请求队列、重试、取消、缓存                 | 核心翻译与性能、可靠性                          |
| KEEP   | OpenAI、OpenAI-compatible、Gemini、Ollama                 | 用户直连自己的服务                              |
| KEEP   | 划词翻译、现有基本解释的请求及渲染                        | 删除附加 Actions 时保留解释                     |
| REMOVE | Auth、Billing、Hosted AI、oRPC、账户 UI                   | 不依赖官方账户或授权状态                        |
| REMOVE | Notebase、复习、云笔记、Google Drive 同步                 | 私人翻译扩展不需要                              |
| REMOVE | 字幕、转录、TTS、安装引导、卸载调查、推广、遥测           | 非核心代码及后台调用链一起删除                  |
| REVIEW | 自定义 Actions、layout-engine、definitions                | 保留解释实际需要的最小边界，不能按包名删除      |
| REVIEW | 非 AI 翻译服务、其他 Provider、术语表、输入翻译、翻译 Hub | 评估双语/译文模式支持与维护成本，删除非必要功能 |
| REVIEW | 权限、资源、本地迁移、通用 UI                             | 按最终引用与实际用途裁剪                        |

## 阶段

0. 记录基线、安装/构建/测试结果与依赖图，独立提交。
1. 删除账户、商业化、官方托管调用与云笔记依赖；保留用户服务路径，构建和必要测试后提交。
2. 删除剩余非核心业务、专属状态/存储/消息/测试，保留基本划词解释后提交。
3. 审计 npm 依赖、资源、权限、环境与构建配置，更新锁文件后提交。
4. 复审不可达代码、多余状态与通信；运行类型/Lint/测试/生产构建，提供体积、网络审计与浏览器手动验收步骤后提交。

每阶段以可运行的核心路径为边界；不伪造授权、不保留空实现。不使用真实 API Key 进行基线或构建。

## Phase 0 实测结果

- 指定上游 `git ls-remote ... HEAD` 与本地 SHA 相同，预置 fork 不影响本次基线。
- 使用预置 pnpm 12.10.1 / Node 26.12.1，`pnpm install --frozen-lockfile` 成功。最初 PATH 中 pnpm 11 与受限 HOME 导致失败；离线缓存不全，启用允许的网络后重装成功。
- Chromium 原版生产构建成功，11.8 秒。使用 `WXT_SKIP_ENV_VALIDATION=true`，因为原版要求 Google OAuth / PostHog 构建变量，本任务不提供这些凭证。
- `oxlint --type-aware --type-check` 成功（原版 lint/type-check 脚本相同）。
- `SKIP_FREE_API=true WXT_SKIP_ENV_VALIDATION=true vitest run`：411 文件通过、1 文件跳过；4370 测试通过、4 跳过；123.91 秒。跳过的免费翻译真实外网测试遵循 AGENTS.md。
- Vitest 初次因沙箱禁止 localhost 端口启动失败，允许测试所需网络后通过，不是代码缺陷。
- 原版已有 PostHog sourcemap 警告和 jsdom navigation 未实现提示。

## Phase 1

移除账户 UI、Better Auth 客户端、官方 oRPC、Hosted AI Registry/流式分支、额度/套餐选择与 Cookie 监听。因依赖同一账户链，云笔记、复习入口、字幕与转录、引导、Hub、Drive 同步一起删除；自定义 Actions 编辑器也删除，已有划词解释执行/渲染保留。Lite 使用独立配置键 `readFrogLiteConfig` 和 schema v1，不导入上游配置，删除 115 版迁移链。恢复界面的本地配置导出保留。

必要回归：DOM/翻译核心/请求队列与新装 Provider 配置测试 24 文件、360 测试通过。生产构建 13.43 MB（阶段中间结果），类型/Lint 检查后提交。专属 Hosted/Notebase/字幕测试删除，混合测试仅移除已删除功能的用例；最终阶段继续运行全量剩余测试。

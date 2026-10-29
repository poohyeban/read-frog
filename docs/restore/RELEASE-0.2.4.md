# Read Frog Lite 0.2.4

修复网页脚本加载与扩展上下文生命周期中的三个已确认问题。保留现有网页、划词、字幕、Provider 和本地配置行为，不增加功能或浏览器权限。

## 修复内容

- **YouTube 的 `Unsafe attempt to load URL ... content-runtime.js`**：0.2.3 在网站 Service Worker 控制页面后，动态加载扩展 ES 模块会产生浏览器资源错误。现在将同一套运行代码打包进浏览器注入的 `loader.js`，删除单独的运行模块、分块和对应 web-accessible resources。源码里的相对导入由 WXT 内联，运行时不再请求 JavaScript 模块 URL，也不需要禁用网站 Service Worker。
- **`Receiving end does not exist`**：为 `@webext-core/messaging@4.0.0` 的 ESM 入口提供锁定的 pnpm 补丁，读取 `tabs.sendMessage` 回调中的 `runtime.lastError`，让没有接收端的情况进入现有 Promise 错误处理。保留消息协议和正常响应语义。
- **启动阶段的 `Extension context invalidated`**：字幕入口在异步读取之前注册清理；配置、语言与模块初始化完成后检查上下文；失效后停止启动、清除注入标记。网页 UI 启动和字幕位置 / 自动启动读取也处理相关中断。非上下文失效的意外错误仍保留诊断能力，不向用户界面添加技术错误提示。

## 验证与边界

- TypeScript、Lint、270 个测试文件 / 2,605 项单元测试通过。
- 三组 Chromium 生产扩展回归覆盖网页 / 划词 / DeepSeek 结构化请求与凭据隔离、字幕连续翻译 / 长字幕跳转 / AI 时间轴回退，以及网站 Service Worker / 无接收端标签页 / 启动中重载扩展。
- 同一份 CI ZIP 在 Linux Chrome for Testing 156.0.8078.47 的真实 YouTube 上验证：网站 Service Worker 保持开启，连续三次加载扩展界面，没有记录到这些扩展错误。真实站点测试不调用翻译 API。
- 用户报告的“正常切回页面就发生上下文失效”的自然触发条件尚未完整复现；本版修复了确定的启动和异步读取缺口，不宣称已证明所有失效来源。
- 未使用用户的 DeepSeek Key，也未验证其个人配置、额度、网络或 Windows / Edge 环境。升级扩展后仍需刷新已打开的网页，使浏览器注入新脚本。

## 产物与维护

- ZIP：`read-frog-lite-0.2.4-chrome.zip`，4,654,856 字节；较 0.2.3 增加 20,675 字节（约 0.45%）。解压后 14,711,708 字节。
- SHA256：`fdb174c83fe56b9fd24d30c0382ffe22222732645effc57e3fd1ff46f1e7ad49`。
- runtime / dev 直接依赖仍为 56 / 37；没有新增依赖、权限或非必要网络服务。
- 禁用站点仍在运行代码初始化前退出，但浏览器会注入和解析合并后的 loader；未进行跨设备性能基准，不能据此宣称启动更快。
- 升级消息库时检查上游是否已修复回调，再更新 / 删除 `patches/@webext-core__messaging@4.0.0.patch`。安装由锁文件校验补丁；开发和真实站点回归命令见 README。

发布直接使用通过 CI 的 ZIP，并检查版本、GPL / 第三方许可证与校验值，不在发布阶段重新构建。安装请下载扩展 ZIP，解压到原扩展目录后重新加载，不要用 Source code 当安装包。

验证记录：[最终 CI](https://github.com/poohyeban/read-frog/actions/runs/40868197221) · [Chrome 156.0.8078.47 / 真实 YouTube](https://github.com/poohyeban/read-frog/actions/runs/40868012940)。真实站点检查使用的先前 CI ZIP 与最终 CI ZIP 的 SHA256 完全相同。

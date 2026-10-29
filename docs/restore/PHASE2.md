# Phase 2：原生字幕恢复

来源：Read Frog v1.54.1 `aa6d54d1b9fde901fa7dbc00540a196fd28cd388`。逐文件依赖审计见 phase2-files.json；额外恢复原 use-proximity-hover.ts，供字幕颜色配置控件使用。

保留 YouTube player-response/interceptor、Netflix TTML/interceptor、X TextTrack 轨道，原播放器定位、导航/广告/直播保护、按时间调度、按需翻译、翻译缓存、双语/仅译文、源轨切换、SRT 导出、字幕查词/暂停、视频摘要、用户 LLM 重分段、样式/Prompt/请求队列设置及测试。字幕模型的 start/end 为毫秒。

移除官方 AI 转录任务客户端、账户状态与配额组件、Hosted Provider 分支、Notebase 保存和遥测。未配置的外部 ASR 不接入原生轨道按钮，不存在官方备用请求。原可替换 fetcher 接口的生命周期与取消保护继续保留。

Markdown 摘要禁止自动加载模型返回的远程图片。全部字体和图标应本地打包；最终阶段统一补齐图标并审计网络。

数据库升级至 v3，新增原 aiSegmentationCache 表及过期清理；配置缺少 videoSubtitles 时继承现有页面 Provider，自动启动默认关闭。术语表适用于字幕 Prompt 和缓存键。

原依赖 entities 与 react-markdown 恢复。移除仅适用于已删除纯翻译/Hosted Provider 的测试；缓存、分段、原生轨道及并发取消测试保留。

生产构建通过，精确指标及全量回归结果见最终报告。真实 YouTube、Netflix、X 网站兼容性仍需实际浏览器验收。

验证记录：全量 246 个测试文件执行了 2474 项；其中两个旧断言（缓存 alarm 数量及旧配置 fixture 未排除新字段）修正后，相关 2 文件 / 24 项复验通过，并增加 AI 分段缓存清理覆盖。类型与 lint 通过。Chromium 构建 13.26 MB。最终阶段再跑一次完整套件。

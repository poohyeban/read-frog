# Phase 5：独立性、许可证与交付验证

- 移除许可证未确认的 @read-frog/definitions，使用 GPL 本地化、MIT ISO 数据和标准 ICU/CLDR 别名生成独立语言模块；YouTube ID 独立解析。不复制私有包实现。
- 清理官方服务旧注释 / Notebase / 订阅配额文案，补齐恢复入口的本地图标注册，图标编辑仅接受本地集合。
- 字幕原生 timedtext URL 加 HTTPS / host / path 边界和 redirect:error；AI 错误正文不送往 UI，不日志输出原 SDK 错误。保留 HTTP 状态 / 重试元数据。TTS 校验响应 MIME 与所选输出格式相符。
- 新增语言映射 / 视频 URL / 凭据反射测试；恢复代码的相关失败夹具修正后全量 260 文件、2544 项通过（含浏览器发现的空服务选择器回归修复）。Lint、TypeScript、全项目格式、Chromium MV3 生产 ZIP 通过。
- 本环境 Chromium 未加载 unpacked 扩展，Service Worker 等待超时。保留失败证据。GitHub Actions run 40827815730 已通过真实 Chromium 核心文字翻译 / 输入 / 划词 / 恢复 / 配置持久化回归；真实视频平台和音频服务仍待人工验证。
- Actions 构建并上传 ZIP / 测试报告；取消不适用的上游运营工作流，pre-push 从不存在的 Nx 改为当前检查。README 引导下载云端 Artifact，不要求个人电脑编译。
- ZIP 包含 GPL、来源说明、第三方许可证通知。版本 0.2.0，名称 Read Frog Lite。完整协议 / 网络 / 来源 / 手动验收 / 限制见 REPORT.md 和 MANUAL-ACCEPTANCE.md。

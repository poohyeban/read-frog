# Phase 1：本地翻译能力恢复

恢复来源与文件导入清单见 [phase1-files.json](phase1-files.json)。源头为 `aa6d54d1b9fde901fa7dbc00540a196fd28cd388`；翻译队列、网页消息和 Prompt 文件复用本仓库 `8cb25cc5` 中已移除账户调用的派生版本，再清理遗留类型与遥测。没有恢复官方服务。

- 输入翻译：原 triple-space hook、语言循环、焦点/异步编辑保护、撤销、Draft.js/Lexical/Slate 桥接；补充页面消息来源及字符串校验。
- 浮动工具：原拖动、长按、左右停靠、锁定、显示控制、翻译状态同步。原侧边栏仅占位，排除；排除 Featurebase 反馈/推广入口。
- 本地术语表：原 CRUD/CSV/站点和目标语言范围/优先级/边界匹配/容量限制。Lite DB 升级至 v2，保留两个缓存表并加入 glossary/glossaryTerm。原唯一复合索引保留。不恢复云同步表。
- 术语实际接入页面、输入、划词 Prompt；匹配结果进入缓存键，带 revision 的批处理保持新增/修改/删除后一致，保留失败退回单项请求时的术语。
- 自定义 Actions：原自动保存、模板、输出 schema、Provider 选择、复制/删除/排序、快捷键、工具栏固定/更多菜单。恢复独立 Improve Writing 定义。结果使用已有 GPL 字段列表。
- 不恢复专有 layout-engine、Notebase；原 AI 配置助手的 Prompt 包含该独立包的布局合约，随布局编辑一并排除，独立 Action 手工配置完整可用。
- 保留原悬停段落实现。翻译中心已审计，与 TTS 入口一起在 Phase 3 恢复，避免临时播放空实现。
- 配置 schema 升至 2；旧配置新增输入翻译继承已选择 Provider，缺少写作动作时继承词典 Provider，避免默认 Provider 已被用户删除时重置配置。

验证：189 文件 / 2042 测试通过（65.53 秒）；oxlint --type-aware --type-check 通过；Chromium MV3 生产构建通过（9,327,891 字节）。恢复的 Lexical 测试需要 devDependency lexical@0.52.0。真实浏览器验收尚待最终阶段，不把这些测试等同于网站实测。

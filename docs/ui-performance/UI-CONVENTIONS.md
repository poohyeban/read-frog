# UI 约定与阶段 2 布局

- React 19 / Base UI / Tailwind token 是共享基础。固定图标用 Tabler 命名导入（16 px、装饰图标 aria-hidden）；用户自定义动作继续使用离线 Iconify 注册表。已有 Remix 不为视觉统一而机械替换。
- 可交互控件使用仓库 `components/ui/base-ui` 包装层。Tooltip 补充说明，不能替代按钮的可访问名称；图标按钮、switch 和 selector 必须有 aria-label 或关联 label。弹层提供 title/description，Escape 关闭后焦点回触发器。
- 简单过渡为 100–150 ms CSS，支持 reduced motion。slider/color-picker 等持续拖拽复杂动画按证据保留 Motion。
- Popup 固定 320 px、16 px 水平内边距；顶部品牌与 Hub/设置并排。语言 → Provider/风格 → 主动作 → 网站控制 → 快捷键/AI 上下文，主要功能仍直接可达。
- 使用 background/foreground/muted/border token；长标签 min-w-0 + truncate，语言完整名称有 title。图片指定尺寸，字体采用 swap 与 unicode-range，避免引入额外字体。
- Jotai 负责可编辑配置，Query 负责远程异步服务；Popup tab/status 是消息适配器投影，翻译生命周期仍由原 headless engine/后台拥有。站点列表从配置和捕获 URL 派生，不再保存另一份布尔状态。
- Provider 摘要只订阅分配 ID 与 Provider 配置的稳定投影，合并同一 Provider 图标；具体“功能 → Provider”分配仍在原抽屉中完整显示。没有新增全局 Context、框架或运行时依赖。

阶段 2 生产截图 smoke：深浅色 × 中英文、长标签、多 Provider、受限页面、缺 tab、消息失败/超时、tabs 失败、loading、1.25/1.5 deviceScaleFactor、剩余八种 UI 语言。常用中英文布局 426 px（原 472 px）。完整视觉/交互截图最终统一保存，deviceScaleFactor 不冒充浏览器原生 zoom。

依赖审计补充：`cn` 被 styles/utils.ts 直接使用；`shadcn/tailwind.css` 被全局主题导入，因此均保留，不能将 shadcn 当作无用 CLI 整包删除。Lexical 是适配测试/类型依赖；TanStack Store 是 Form 订阅实现；Motion 仍有真实复杂动画使用者。本轮不为了“删除依赖”破坏这些用途。

# 前端审计与实施决策（阶段 0）

基点：`bb14e8bb14c06cfa8abe24f54a6b0505e46880e5`，远程 `codex/translation-architecture-upgrade` 已只读核对一致。工作区原本干净。本轮分支 `codex/popup-ui-performance`，只做本地提交，不 push、不开 PR、不操作 Actions。

## 测量边界

Node 24.19.0、Linux、Chromium 154.0.8037.57、生产 WXT 构建。管理员 `ExtensionInstallBlocklist=["*"]` 禁止加载未打包扩展，真实 MV3 测试在等待 service worker 时失败。这里通过 HTTP 运行未经改写的生产 HTML/JS，注入 API fixture：storage 5 ms、tabs 15 ms、消息 10/120 ms。后者代表两个受控延迟条件，不是实测 worker 唤醒时间。每组 30 次，cold 使用新浏览器上下文，repeat 使用同一上下文中新文档；同一文档的 React 状态不会复用。未使用在线模型。原始样本、API 调用时间、浏览器 ScriptDuration/TaskDuration、React production DevTools commit 时间、资源加载、CLS 及截图保存于 baseline/。

真实环境的磁盘缓存、扩展进程、worker 启停、完整端到端验收仍须在允许扩展加载的浏览器补测。React production hook 记录 commit 时刻，不等同于 profiling build 的逐组件 actualDuration；不将 StrictMode 开发开销混入生产结果。

## 启动链路与 P0

`main.tsx` 静态模块 → 并行 config/theme/tabs → i18n → 后台翻译状态 → getIsInPatterns 再次 tabs.query → React mount → configAtom.onMount 再读取校验。

- 后台未响应时整个 UI 不挂载，异常没有启动级恢复。应让配置控件独立就绪；页面状态明确 loading/ready/error，未知状态不可点击。
- 重复 tabs 查询在串行关键路径，点击翻译、网站开关又再次查询。应捕获一次目标 tab，站点 flags 从该 URL 和当前配置派生，避免跨 tab 误操作及外部配置更新后 flags 陈旧。
- TranslateButton 发消息后无确认地翻转状态，错误不可见。应监听现有状态消息并处理超时/失败，仍通过已有消息契约与 Headless engine 通信。
- 账号空节点、空 Fragment 和无效注释仍产生顶端留白。Hub 图标独占一行而没有可访问名称。重排为品牌 + Hub/设置工具栏，保留所有主要控件。

## 构建证据与 P1

静态传递依赖（含 HTML modulepreload；gzip 仅参考，扩展通常读本地资源）：Popup JS 1,802,425 B / CSS 207,137 B；Options 1,612,250 / 207,077；Hub 2,995,886 / 207,053。见 baseline-bundles.json。共享 storage chunk 913,015 B、theme 352,317 B、switch 138,534 B、os 115,243 B。不要把整个 chunk 的成本错误归因于同名功能。

十种 locale YAML 合计约 751 KB 源文本，全部静态导入并在运行时递归转换占位符。拟对 HTML UI 按语言加载本地构建 chunk，同时保持 worker/content 的同步资源兼容；保留 en fallback、所有语言和插值。必须验证不把动态 import 引入不支持它的 MV3 worker。

Provider Drawer 与完整 feature selector 初始静态加载；仅在有预热与首次打开测量保障时拆分。语言列表保留 Base UI 键盘语义，不自造选择器。Switch 为拖拽交互引入 Motion；保留拖拽和键盘行为，评估用 DOM/CSS 实现短距离过渡，不能简单删掉功能。Drawer 500 ms 过渡明显长于简单弹出需求，且缺 reduced-motion 类。字体采用 unicode-range 与 swap，不能把所有打包字库当作首屏实际请求。

Hub 静态引用 executeTranslate，将模型执行依赖带入空白编辑页；应在用户发起翻译时加载，并保持取消/过期请求隔离。Options 已有 React.lazy 路由，保留 CodeMirror/术语/复杂编辑器拆分。全局 CSS 是 Tailwind 共享输出，拆成多套样式的收益未证明，暂保留。

## 全入口技术栈与所有权

| 范围 | 当前工具及决策 |
|---|---|
| 所有 React UI | React 19、WXT/MV3、Vite、Tailwind 4 保留；共享 token 与 Base UI 交互组件 |
| Popup | Jotai 配置/页面状态，Base UI combobox/select/drawer/tooltip/toast；不引入 Router；按需复杂面板 |
| Options | React Router hash 路由、lazy 页面、TanStack Form/autosave；CodeMirror 限定编辑器路由；保持恢复边界 |
| Translation Hub | Jotai 可编辑输入/请求、Query mutation、服务执行工具；将服务实现移出初始图 |
| 划词/输入/浮动 UI | content-runtime React root、Jotai、Query、共享交互组件；生命周期属于宿主 controller，不搬入 Popup |
| 字幕 | 独立 UI context、React/Query 和共享样式；本轮不改字幕调度业务 |
| Lexical | 输入注入适配器的类型和测试依赖；不作为自有页面编辑器打包，保留 devDependency |
| TanStack Store/Form | 表单状态内部使用，非第二套全局配置状态；不机械移除 |
| Query | 真正异步请求/重试/mutation；配置归 Jotai/storage，翻译引擎归 headless 契约 |
| Motion | slider/color picker 等复杂拖拽可保留；普通短动画优先 CSS，遵守 reduced motion |
| Iconify/Tabler/Remix | 本地离线动态图标用于用户自定义动作；固定新 UI 用命名 Tabler 导入；不替换全部存量图标 |
| shadcn | 仓库内设计约定和 CLI；不新增另一套 Radix 等交互底座。CLI 不属运行时需求 |

Provider 摘要订阅整个 configAtom，任何配置变化都重复构建所有功能的 Provider 分配，应改为稳定的相关投影。不要 blanket memo。configAtom 初始重读承担订阅安装前后竞态保护；没有可靠修订号握手前不随意删除。现有串行写入、乐观更新与跨上下文同步测试必须保留。

## 框架选择

保留 React 19。测得瓶颈包括应用等待链、语言资源、拖拽库和服务实现依赖；没有证据表明换框架能消除这些成本。Preact compat 可能减少核心 runtime，但 Base UI、Jotai、TanStack、Router、Motion 的行为兼容须逐项验证；Solid/Svelte 需重写组件、hooks 与第三方交互层，迁移范围远大于当前性能问题。三者都可在一般 MV3 页面构建运行，但这不证明当前生态兼容或本项目启动更快。未安装候选框架，未伪造体积/启动对比数值；净收益未证明，不发起迁移。后续只有相同功能小型实验和兼容性测试支持时才独立提案。

## 基线结果

| 条件（模拟消息延迟） | 内容 DOM P50/P95 ms | 正确状态可交互 P50/P95 ms | 首个内容绘制上界 P50/P95 ms |
|---|---:|---:|---:|
| cold / 10 ms | 392.6 / 432.8 | 392.8 / 433.1 | 448.4 / 502.8 |
| cold / 120 ms | 488.2 / 540.3 | 488.3 / 540.5 | 548.6 / 597.4 |
| repeat / 10 ms | 356.9 / 418.3 | 357.0 / 418.7 | 414.8 / 502.2 |
| repeat / 120 ms | 470.6 / 511.2 | 470.7 / 511.5 | 527.3 / 570.7 |

内容绘制为 DOM 出现后的双 rAF 上界，另存浏览器 FCP；不能将它当成精确光栅化时刻。每组保留全部 30 样本，不剔异常值。后续同机同脚本复测。

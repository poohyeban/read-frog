# 阶段 3：交互实现收敛

共享 Switch 保留 Base UI 语义、controlled/uncontrolled、取消事件、disabled/readOnly、指针捕获、拖拽与中途接管；短距离动画改用 CSS，读取实际 transform 以免拖拽跳动。普通切换不再依赖 Motion 调度。Drawer 的 500 ms 过渡改为 150 ms，并遵守 reduced motion。

Popup 静态 JS 从阶段 1 的 1,117,090 B 降至 987,241 B（含阶段 2 布局）；约 130 KB 的动画运行时离开初始依赖图。Motion 继续用于复杂 slider/color picker，没有删除依赖或削弱其功能。共享控件与配置状态测试 7 文件 / 21 项通过，静态类型检查通过。最终阶段补浏览器指针拖拽和所有入口回归。

所有直接依赖已搜索使用者。未直接导入的 `@codemirror/state` 是编辑器 peer/dedupe 依赖，`@wxt-dev/i18n` 是 WXT module 和构建类型生成入口，均不误删。确认移除的是 Popup 的账号空容器/无效注释、重复状态布尔 atom、重复 tabs 查询及 Switch 对 Motion 的导入。没有安装新库。

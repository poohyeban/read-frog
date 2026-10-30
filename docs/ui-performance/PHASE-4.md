# 阶段 4：完整页面的实际成本

Hub 的 executeTranslate/语言检测模块从静态依赖移到实际请求时加载；空输入、手动源语言不做检测，文本变化/页面关闭后丢弃过期检测。翻译模块加载完再次检查 AbortSignal 与 request ID，保持原取消/过期响应隔离。

Options 保留原路由 lazy 拆分。API Provider 首页的 AdvancedOptionsSection 原来 keepMounted，导致从未展开的 JSON 编辑器也被挂载。现在首次打开才挂载，之后继续 keepMounted，保留关闭期间的原始 JSON（包括不完整草稿）及 autosave 注册。JSON CodeMirror 单独本地 chunk，指针/键盘接近 advanced trigger 时预热。

生产静态传递 JS：Hub 1,187,687 B（原 2,995,886 B，约 -60.4%）；Options 1,027,840 B（原 1,612,250 B，约 -36.2%）。Options 的主页路由还会加载额外 chunk，因此最终报告同时列真实网络资源与路由就绪指标，不把 HTML 静态图误作完整首页体积。编辑器从初始页移到第一次打开会有额外读取成本，最终单独测量这个权衡。

相关页面/i18n 14 文件 50 项测试通过；新增初次挂载、保留无效草稿、检测取消/过期结果、locale 切换竞态等 7 项通过。完整套件在本阶段前通过 289 文件 2702 项，最终阶段在代码冻结后再次验证。

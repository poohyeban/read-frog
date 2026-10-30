# UI 收尾验证

基线 `bad35243a594b01a588fed3eee7a20a63da327d2`，远程 UI 分支相同，开始时工作区干净。新分支 `codex/subtitle-session-upgrade`；本轮仅本地提交。

## 已确认并修复

- 持久化 `enabled=false` 只是用户意图，无法证明 Content Script 管理器已停止。新增直接 top-frame RPC 确认，等待现有 manager.start()/stop()，核对地址及导航代次。无接收器/超时显示错误；重试读取实际管理器状态。旧存储接口保留给既有消费者，不再用于 Popup 确认。手动拒绝记录先保存。32 ms 首屏合并预算保持。
- 首次超过拖动阈值的位移被丢弃。保留按下锚点并立即应用首个 move；保留 Base UI 事件取消、键盘语义和 CSS reduced-motion。

## 验证

- 4 文件 / 58 测试通过，包括 Popup→后台桥接→管理器的联合契约、提前 false、消息丢失、同 URL 重载/导航、迟到回执、关闭 Popup、失败启动、pending start 停止；Switch controlled/uncontrolled/反向/取消/只读/禁用。
- Oxlint 类型感知与类型检查通过；WXT 生产构建通过。
- 生产 Popup 在 Chromium 154 的 13 组功能检查通过：单次 move、反向、原生 CDP touch、取消、键盘 Space、单次写入、reduced-motion、原有设置持久化。
- `ui-locales/raw.json`：30 样本×3 语言×2 冷/重复×2 版本=360 次，AB/BA 交错；后台 API 固定模拟120 ms。`summary.json` 保存 meaningful DOM/paint/可交互 P50/P95；`locale-chunks.json` 保存中文 chunk 网络耗时与字节数。冷启动指全新 browser context，非操作系统冷启动。
- 修复后冷启动交互 P50：en 387.0 ms，zh-CN 414.2 ms，zh-TW 412.9 ms；重复打开分别359.8/397.1/399.3 ms。未声称有显著速度改善；保留尾延迟和全部样本。
- 测量使用真实生产资源、模拟扩展 API；新 RPC 的实际跨上下文代价未通过此 fixture 测得。浏览器管理策略 `ExtensionInstallBlocklist=["*"]` 仍阻止加载扩展，不能作为真实 MV3 验收。

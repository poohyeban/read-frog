# Read Frog Lite 0.2.7

本版整合字幕引擎的可靠性、长视频性能与缓存恢复改进，包含 `codex/subtitle-engine-v2` 至 `1af30d16` 的全部修复。

## 更新内容

- 字幕 Fast / Quality 双通道优先保证当前位置可读，再补充高质量结果；共享请求继续复用，Stop、导航和断连回收旧任务及租约。
- 请求统一使用现有物理资源调度、有限重试与 Provider 隔离；资源设置保留禁用服务组成员，不因临时禁用丢失配置。
- 优化长视频字幕索引、可视列表、增量更新及历史兼容身份的计算时机。保留严格旧缓存恢复，修复无效 AI 分段旧缓存删错 Key 的问题，不清除用户缓存。
- 修复重复原文字幕的临时译文位置冲突，支持乱序输出和单成员恢复；不同标签、不同批次的相同恢复请求仍可共享。
- 修复同一 Session 反复 Stop/Start 且撤销 RPC 失败时旧 Promise 与重复 RPC 累积。500 次循环撤销请求由 125,250 次降至 500 次，停止确认失败仍明确返回，不伪装成功。
- 流式 HTTP 已发送但尚无任何 text / reasoning delta 时断流，不再自动重放；明确 HTTP 429 仍可按原有限额度重试。截断结果只保留完整成员，部分缓存的首尾空位不再丢失。
- **流式实验默认关闭**，普通安装仍使用稳定的完整响应路径。没有扩大 API 尝试额度，也没有增加独立物理限速器。

## 验证与边界

本地专项 141 项、完整 Vitest 328 文件 / 2976 项、类型检查、Oxlint、格式检查及 MV3 构建通过。九个 HTTP 专项共 66 次本地请求，全部收尾的调度任务、租约、端口监听器及 fallback 路由余额为零。永久挂起读取仍如实保留一个未结算 Promise，不继续派生读取或定时器；八小时后恢复的旧结果不能污染新会话。

失败/通过对照、请求次数、资源余额及限制见[定向可靠性报告](https://github.com/poohyeban/read-frog/blob/main/docs/lite/final-reliability-review/REPORT.md)。此前 165 场景、长视频与缓存性能对照见[字幕验收报告](https://github.com/poohyeban/read-frog/blob/main/docs/lite/subtitle-streaming/REPORT.md)。这些本地测试不替代真实线上平台、模型质量或原生 Worker 自然休眠验收。

发布附件只使用完整 GitHub Actions 检查通过的原始生产 ZIP，校验 Manifest、许可证和 SHA256。实际 CI 来源、校验值及浏览器验收结果将在发布前写入本版本构建记录。

## 安装与升级

下载附件 `read-frog-lite-0.2.7-chrome.zip`，不要下载 `Source code` 作为安装包。解压后完整替换原扩展目录，保持原路径，在 `chrome://extensions` 点击重新加载，再刷新已打开的网页。附件 `SHA256SUMS.txt` 用于校验。

建议升级前导出配置和术语表；不需要卸载重装或清空缓存。保持扩展 ID 不变。真实 YouTube / Netflix / X、具体 Provider 和自然 Worker 生命周期仍需按[原生验收清单](https://github.com/poohyeban/read-frog/blob/main/docs/lite/subtitle-streaming/NATIVE-MV3-CHECKLIST.md)检查；受控回归不能承诺所有站点和模型兼容。

# edbe6ed6 资源组编辑一致性验收

基于 `edbe6ed681906aaebc6be73fd831121b9b2627b7`。本轮仅本地修改、测试、构建与提交。

## 根因与修复

原 `PerformanceGroups.edit()` 把组成员过滤为 UI 可见资源，保存时以整个成员数组替换持久化记录；后台设置查询与写入校验又只使用启用 Provider 的身份。因此仅改名称也可能移除禁用成员，旧草稿还会覆盖另一设置页的成员修改。

- `resource-runtime.ts` 的设置快照提供已有的 `configuredIdentities`，包含全部已配置、已验证的身份；活动身份仍单独用于远程请求。后台设置查询和成员新增校验使用前者。禁用账号可显示、保留和显式重新绑定，但不能借此获得执行资格。
- `groups.tsx` 保留编辑开始时的完整成员快照，只提交用户实际修改的名称、`addMembers` 与 `removeMembers`。后台 `performance-patch.ts` 将增删应用到最新记录，不再接受整数组替换。未修改的名称也不提交，避免成员编辑覆盖另一页的改名。
- 继续使用现有唯一串行 `performance-writer.ts`。写入前校验身份快照仍是当前版本；身份快照过期时报错并保留编辑草稿。新增成员必须属于后台验证的已配置身份，伪造、已删除及已轮换的旧身份不能重新加入。移除为幂等操作，不会新增任何身份关联。
- 显式移除最后一个成员仍保留组名称和策略；相同物理身份的 Provider 别名仅显示一个复选框。禁用 Provider 的继承默认值来自所属组，相同值不会产生冗余覆盖配置。

持久化仍沿用 Defaults + Sparse Overrides 和原数据库升级链，没有增加数据版本或兼容状态机。ResourceScheduler、BatchQueue、字幕引擎、翻译缓存、身份 vault 和迁移文件均未修改。

## 确定性回归

| 场景                                      | 证据与结果                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| A+B 合组 → 禁用 B → 改名、添加 C → 启用 B | UI 与真实后台设置处理器分别验证；A/B/C 保留，B 恢复组策略                   |
| 禁用 B 时显式移除、重新添加、再次移除     | 真实身份解析/写入链验证；移除后重新启用不会自动回组                         |
| UI 身份暂不可见，或身份解析不完整         | 改名仍保留原成员，不把不可见误判为用户删除                                  |
| 重复身份别名及删除 B                      | 别名去重；最后一个别名仍存在（即使禁用）时保留成员；最后引用消失才清理      |
| 旧身份、伪造身份                          | 新增和创建均拒绝；更换 Key 不继承旧组关系                                   |
| 并发改名、添加、删除成员                  | 增删合并，保留策略与无关字段；旧草稿不复活已删除成员，不覆盖另一页改名      |
| 延迟持久化期间删除 B，同时添加 C          | 用 Promise 闸门确定顺序；最终保留改名、A/C、组策略及 A 的性能配置，B 被清理 |
| 快照过期、并发删除整个组                  | 拒绝过期写入，不复活组、不覆盖已有设置；可用新快照重试                      |
| 无操作保存、重复补丁                      | 不产生额外写入或 revision 增长                                              |

测试位置：[组编辑器](../../../src/entrypoints/options/components/performance-settings/groups.test.tsx)、[后台 Runtime](../../../src/utils/providers/__tests__/resource-runtime.test.ts)、[串行 Writer](../../../src/utils/config/__tests__/performance-writer.test.ts)。

并发边界：同一字段上的相互冲突显式编辑按后台串行顺序生效。Provider 配置和性能配置是两个存储键，不宣称跨键数据库事务；已开始的性能写入结束后，由现有串行 reconciliation 按最新 Provider 引用清理，仅移除已无引用的成员。延迟持久化测试覆盖这一顺序。解析失败时保留既有成员，不把暂时故障当作删除。

## 执行记录

所有 Provider 均为 Mock；测试使用 `SKIP_FREE_API=true`，没有调用付费 API。

```sh
SKIP_FREE_API=true ./node_modules/.bin/vitest run src/entrypoints/options/components/performance-settings/groups.test.tsx src/entrypoints/options/components/performance-settings/index.test.tsx src/utils/config/__tests__/performance-writer.test.ts src/utils/providers/__tests__/resource-runtime.test.ts
SKIP_FREE_API=true ./node_modules/.bin/vitest run
./node_modules/.bin/oxlint --type-aware --type-check
./node_modules/.bin/oxfmt --check .
./node_modules/.bin/wxt build
BENCHMARK_KIND=resource SKIP_FREE_API=true node e2e/subtitle-harness/run.mjs /workspace/read-frog /tmp/read-frog-group-browser
```

| 检查                   | 结果                                                                 | 证据                                                                                              |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 定向回归               | 4 文件、32 项通过                                                    | [targeted.txt](group-editor-evidence/targeted.txt)                                                |
| 完整 Vitest            | **318 文件、2,872 项通过**，208.70 秒                                | [vitest.txt](group-editor-evidence/vitest.txt)                                                    |
| 类型检查 / Lint        | 仓库两个脚本均对应 `oxlint --type-aware --type-check`；退出码 0      | [lint-typecheck.txt](group-editor-evidence/lint-typecheck.txt)                                    |
| 格式检查               | 全仓通过                                                             | [format.txt](group-editor-evidence/format.txt)                                                    |
| WXT 生产构建           | WXT 0.21.4，Chrome MV3，**14.93 MB**，退出码 0                       | [build.txt](group-editor-evidence/build.txt)                                                      |
| Chromium Mock 资源回归 | 11 项全部通过；停止 100 次后新增请求 0；无资源泄漏；设置并发合并通过 | [browser.json](group-editor-evidence/browser.json)、[执行日志](group-editor-evidence/browser.txt) |

本轮新增 12 项回归；已有不完整身份恢复测试增加了改名保留成员的断言。Node v24.19.0，Chromium 154.0.8037.57。浏览器回归使用真实 Chromium 中的生产模块与本地 Mock，不是原生扩展 Service Worker E2E。本轮没有改动性能热路径，也没有用这次功能回归的耗时宣称性能提升。全量测试输出保留了 jsdom navigation 与 SDK JSON schema 兼容性提示，测试进程仍以 0 退出。

文本证据只清理终端颜色、行尾空白；测试结论未改写。没有推送 GitHub、创建 PR、触发 Actions 或发布 Release。

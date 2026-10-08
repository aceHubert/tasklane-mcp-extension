# [2026-10-06 20:50 +0800] | 任务：Review 阶段隐藏通用继续执行

## 执行上下文

- **Agent ID**：Codex，并行回归测试与独立只读审查。
- **Base Model**：GPT-6；具体宿主模型 ID 未确认。
- **Runtime**：Codex Desktop，本地 Node.js。
- **Git User**：hubert <hubert@lejian.com>。
- **Branch**：main；未 add、commit 或 push。
- **关联计划**：无（局部 UI 显示修正）。

## 用户诉求

> 通用的“在 Codex 中继续执行”在 Review 阶段就不要显示，不区分条件。

同时保留不可参与 Review 的无项目任务不显示通用续接的要求；初次启动仍可用。

## 变更概览

- TaskDetail 在 Review 阶段统一隐藏执行区通用按钮、续接提示词和该按钮的阻断说明，不依赖审核是否结束、结论、绑定或 Review 子状态。
- 原有“开始 Review／继续修改／继续验收”和审核结论默认提示词保持原样；打开已绑定聊天、核对状态入口保留。
- 非 Review 项目阶段沿用原有执行守卫，包括已创建但尚未绑定的 blocked 恢复入口；无项目任务已有会话的通用续接隐藏，非 Review 的初次启动保持。
- 插件、市场与 UI 版本同步为 0.3.18；看板与报告 URI 换为 v0318，避免宿主复用旧 UI 缓存，重新构建自包含插件产物。
- 本轮未修改 completed 回执、Doing→Review 流转、真实任务数据或原生聊天绑定。已有审核草稿轮次与结论长度边界留入技术债，未在本轮调整。

## 验证结果

- 最终 UI 类型检查、构建与全量测试通过：86 项，0 失败。
- 新增实际 TaskDetail Hook/JSX 交互测试 9 组：Review 所有阶段与绑定条件隐藏、旧 fix/recheck 路由保留、普通项目续接、无项目隐藏、Ready 首次执行及 created-unbound blocked 恢复。
- 核心/MCP `pnpm test`：326 项通过；本轮只同步报告 URI 测试字面量，没有修改核心状态机。
- `pnpm build:plugin`、`pnpm verify:plugin`、`pnpm smoke`、`git diff --check`：通过；最终插件产物为 0.3.18。后台验证配置 60 秒硬超时，没有超时。
- 内置 Chrome 首次请求头策略加载失败，重试成功。用新插件 bundle 与临时 SDK 夹具验证宽视图和 420×900 窄栏：通用继续按钮与普通续接编辑器计数均为 0，待验收的开始 Review 入口仍为 1。
- 夹具验证原“继续修改”仍发送 action=continue、purpose=implementation 及原模板中的审核结论；所有写入只在内存模拟，没有投递真实消息或修改用户看板。临时服务已停止，标签页关闭，视口恢复。
- 独立只读复核未发现本轮功能回归；确认新增测试覆盖了入口显示及恢复路径。
- 未安装或重启宿主插件；新版原生界面验收仍需更新后进行。没有 ESLint/Prettier 配置，未声称相关检查通过。

界面证据：[宽视图上下文](../../acceptance/20261006-review-hide-continue-pending.jpg)、[入口预览](../../acceptance/20261006-review-hide-continue-preview.jpg)、[窄栏](../../acceptance/20261006-review-hide-continue-narrow.jpg)。

## 变更统计

使用本轮修改前快照逐文件执行 `git diff --no-index --shortstat/--numstat`；新增测试与 `/dev/null` 比较。排除任务前已有改动、历史记录自身与自动生成的插件/构建产物。3 张临时夹具截图按二进制记录，不计文本行数。

- **变更文件数**：17（14 个文本文件、3 张截图）。
- **文本新增**：+288。
- **文本删除**：-20。

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| ui/src/components/TaskDetail.tsx | 6 | 3 |
| ui/src/mcp/appsClient.ts | 1 | 1 |
| ui/test/native-execution.test.mjs | 1 | 1 |
| .claude-plugin/marketplace.json | 1 | 1 |
| extension/src/plugin-server.mjs | 1 | 1 |
| extension/src/widget.mjs | 3 | 3 |
| extension/plugin-src/plugin.json | 1 | 1 |
| extension/plugin-src/.codex-plugin/plugin.json | 1 | 1 |
| scripts/verify-plugin.mjs | 3 | 3 |
| mcp/test/apps-report.test.ts | 1 | 1 |
| extension/README.md | 6 | 2 |
| docs/native-execution-contract.md | 2 | 2 |
| ui/test/review-linked-continuation.test.mjs | 259 | 0 |
| docs/exec-plans/tech-debt-tracker.md | 2 | 0 |
| docs/acceptance/20261006-review-hide-continue-{pending,preview,narrow}.jpg（3 文件） | bin | bin |

## 后续事项

更新已安装插件到 0.3.18 后重开面板，核对真实 Review 各阶段均无通用续接入口；原审核、修改、复查入口按既有流程使用。

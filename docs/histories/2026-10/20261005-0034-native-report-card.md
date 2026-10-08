# [2026-10-05 00:34 +0800] | 任务：执行回执在宿主会话内渲染 TaskLane 报告卡片

### 执行上下文

- **Agent ID**：`ZCode（GLM-5.3-FlashX 会话）`
- **Base Model**：`GLM-5.3-FlashX（account:zai-individual-coding-plan）`
- **Runtime**：`ZCode CLI（macOS arm64, Node 22, pnpm 11）`
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main（未提交工作区，含上一任务 task-deadline 的未提交改动）`
- **关联计划**：[docs/exec-plans/completed/native-execution-report-card.md](../../exec-plans/completed/native-execution-report-card.md)

### 用户诉求

> 先在 open-design 中创建一个页面画出卡片的交互（会话中和展开后的详情），然后实施文档功能（docs/exec-plans/active/native-execution-report-card.md）。

### 变更概览

**影响范围**：`mcp/`、`extension/`、`ui/src/mcp/`、`ui/src/state/`、`scripts/`、`docs/`、版本清单与插件构建产物。

**主要操作**：

- **原型（OpenDesign）**：新建项目 `tasklane-report-card`，单页交互原型画出「会话内折叠卡片（running/completed 两形态 + 五状态切换预览）」与「展开后 fullscreen widget（锁定看板 + 聚焦任务详情抽屉 + 执行时间线）」的联动，附数据流与三条交互规则说明。
- **MCP 契约**：`CreateServerOptions` 新增可选 `apps: { resourceUri, widgetDataFor }`；`task_execution_report` 在插件模式下绑定卡片 `_meta` 最小集（`ui.resourceUri`、`openai/outputTemplate`、`openai/widgetAccessible`、`openai/toolInvocation/*`，无 entrypoints），成功结果合并 widget 字段并附 `_meta.widgetData`，text 与 structuredContent 保持同源；错误结果保持 `fail()` 原样。独立模式不传 apps，行为与现状逐字段一致。
- **插件字段组装**：新增 `extension/src/report-card.mjs`（纯函数 `reportWidgetData`：boardHome / lockedBoardId / repoRoot 回退请求仓库与绑定工作区 / projectDir 优先绑定 workspacePath / taskId / mcpClient，路径不可解析返回 null 不阻塞回执）；`widget.mjs` 再导出并换版 `WIDGET_URI` 至 `board-panel-v0315.html`；`plugin-server.mjs` 注入 apps 选项（闭包引用 store 与实际握手客户端）。
- **UI 聚焦**：`WidgetContext` 增加可选 `taskId`（非空、trim 后 ≤ 200，非法值丢弃），并入 cacheScope；`BoardContext` 收到 taskId 后在锁定看板任务加载完成时 `openDetail`（每个任务同一实例仅一次，重复上下文不重开；project-error / global 上下文清除待聚焦）。
- **换版**：插件 0.3.14 → 0.3.15 同步 marketplace、双 plugin.json、plugin-server、appsClient `APP_VERSION`、extension/README。
- **测试与校验**：新增 `mcp/test/apps-report.test.ts`（5 用例：_meta 定义、成功结果合并与同源、null 保持纯结果、无 apps 全等、错误不附卡）；`ui/test/report-card.test.mjs`（4 用例字段回退链）；`ui/test/native-execution.test.mjs` 增 taskId 解析/缓存用例并更新版本断言；`scripts/verify-plugin.mjs` 增 report 绑定断言并同步 URI/版本断言；契约文档新增「报告卡片」小节。

### 设计动机

宿主会话内渲染 HTML 只有 MCP Apps widget 一条通道。选择「apps 选项由插件注入、核心默认不启用」使独立模式与既有断言零变化；widget 字段并入 structuredContent（而非仅 `_meta.widgetData`）以通过 `parseWidgetContext` 的顶层识别；字段组装拆为无依赖纯模块便于单测；聚焦复用 `openDetail`，不引入单卡视图。执行协议语义、存储 v4、report 校验与状态机零变化；纯附加字段对旧客户端兼容。回滚：还原代码后 `pnpm build:plugin` 重装旧版；无数据回滚。

### 验证结果

- `pnpm build`、`pnpm test`：通过（297 项，含新增 5 项 apps-report）。
- `pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui`：通过。
- `node --test ui/test/native-execution.test.mjs`：34 项通过（含新增 taskId 用例与 0.3.15 版本断言）；`node --test ui/test/report-card.test.mjs`：4 项通过。
- `pnpm build:plugin`、`pnpm verify:plugin`：ALL PASS（含新增「task_execution_report 绑定报告卡片」「报告卡片工具不添加侧边栏入口」断言）。
- `pnpm smoke`、`pnpm verify:twoproc`：PASSED（report 既有断言不回归）。
- 既有失败登记：`node --test ui/test/task-detail-controls.test.mjs` 存在 4 项失败（`native.recovery.action` 相关）。已用 stash 验证：移除本次 `appsClient.ts` / `BoardContext.tsx` 改动后同样失败，属上一未提交任务（TaskDetail 改动）的既有问题，与本次无关，未修改。
- 真实宿主出卡与聚焦验收：**未执行**（本会话无法操作真实 Codex 宿主），见计划「阻塞点与下一步」。
- 原型自查：无头 Chrome 截图核对两栏布局与联动状态正常。

### 变更统计

> 口径：工作区相对 HEAD（ce03e8f）的未提交差异同时包含上一任务 task-deadline（已有独立历史记录）。下表仅列本任务触碰的文件；`mcp/src/register.ts` 同时含上一任务的 deadline 参数行，未逐行拆分，按整文件 numstat 计入并如实注明。不含本历史记录、计划文档进度更新与 `.zcodeignore` 等他人/其他任务文件。

- **变更文件数**：16（源码/测试/文档/清单）+ 4（plugins/tasklane 构建产物，`pnpm build:plugin` 再生成）
- **新增行数**：约 +530（源码口径，含上述共享文件整文件行数）
- **删除行数**：约 −21（另构建产物 ±52）

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `mcp/src/register.ts`（含上一任务行数） | 73 | 5 |
| `mcp/src/server.ts` | 8 | 3 |
| `mcp/test/apps-report.test.ts`（新增） | 197 | 0 |
| `extension/src/report-card.mjs`（新增） | 48 | 0 |
| `extension/src/widget.mjs` | 5 | 1 |
| `extension/src/plugin-server.mjs` | 17 | 2 |
| `extension/plugin-src/plugin.json` | 1 | 1 |
| `extension/plugin-src/.codex-plugin/plugin.json` | 1 | 1 |
| `extension/README.md` | 1 | 1 |
| `.claude-plugin/marketplace.json` | 1 | 1 |
| `ui/src/mcp/appsClient.ts` | 9 | 3 |
| `ui/src/state/BoardContext.tsx` | 20 | 0 |
| `ui/test/native-execution.test.mjs` | 37 | 1 |
| `ui/test/report-card.test.mjs`（新增） | 73 | 0 |
| `scripts/verify-plugin.mjs` | 14 | 2 |
| `docs/native-execution-contract.md` | 25 | 0 |
| `plugins/tasklane/*`（构建产物） | 52 | 52 |

### 修改文件

- `mcp/src/server.ts`、`mcp/src/register.ts`
- `extension/src/report-card.mjs`（新增）、`extension/src/widget.mjs`、`extension/src/plugin-server.mjs`
- `extension/plugin-src/plugin.json`、`extension/plugin-src/.codex-plugin/plugin.json`、`extension/README.md`、`.claude-plugin/marketplace.json`
- `ui/src/mcp/appsClient.ts`、`ui/src/state/BoardContext.tsx`
- `ui/test/native-execution.test.mjs`、`ui/test/report-card.test.mjs`（新增）
- `mcp/test/apps-report.test.ts`（新增）、`scripts/verify-plugin.mjs`
- `docs/native-execution-contract.md`
- `plugins/tasklane/*`（构建产物，随 build:plugin 再生成）

### 后续事项

- 真实宿主验收：重装 0.3.15 插件后，在真实 Codex 执行会话验证 running / completed 回执出卡、展开聚焦与看板范围锁定；不通过按计划「风险」回退顺序处理。
- 上一任务的 `ui/test/task-detail-controls.test.mjs` 4 项既有失败待其负责人修复，本任务未处理。

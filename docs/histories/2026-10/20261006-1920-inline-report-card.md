# [2026-10-06 19:20 +0800] | 任务：会话报告只显示卡片，点击后打开详情

## 执行上下文

- **Agent ID**：Codex；并行 UI 实施与独立只读审查。
- **Base Model**：GPT-6；具体宿主模型 ID 未确认。
- **Runtime**：Codex Desktop，本地 Node.js 22.22.0。
- **Git User**：hubert <hubert@lejian.com>。
- **Branch**：main；未 add、commit 或 push。
- **关联计划**：[会话报告卡片](../../exec-plans/completed/native-execution-report-card.md)。

## 用户诉求

> 会话中不应该触发，会话中需要卡片，由卡片触发详情。继续完成。

TASK-110 的真实宿主反馈只有两条 `Opened task_execution_report`；原始回执已完整返回 UI 资源和数据。旧方案把报告绑到默认 fullscreen 的看板资源，需要把报告展示与详情打开分开。

## 变更概览与设计

- 报告独立注册 `report-card-v0317.html`，默认 inline，支持用户请求 fullscreen；普通看板仍使用原资源。版本同步 0.3.17，重新生成自包含插件。
- 报告附带 `presentation: report-card` 与只读标题、任务 ID、优先级、状态、摘要、更新时间快照；非 Git 项目目录及 reviewExecution/reviewBinding 来源独立核对。
- 卡片初始化标记早于应用脚本，等待工具结果也不显示完整看板；缺少 head 时拒绝返回不安全模板。
- UI 初始只显示紧凑卡片，不查询看板或详情。点击按钮才请求 fullscreen，确认结果和当前任务范围后读取并打开详情。
- 拒绝、不支持、断连、未知路由与在途上下文更新保留卡片，不打开旧任务；缓存恢复保持卡片，普通看板 taskId 聚焦兼容。
- 执行状态机、存储、真实工作区和回执规则不变；新增展示字段不迁移数据。回滚可恢复本轮源码与插件产物，没有任务数据回滚。

## 验证结果

- 核心/MCP：`pnpm build`、`pnpm test`，326 项通过。
- UI：类型检查、构建通过，最终全量 `ui/test/*.test.mjs` 77 项通过。
- 插件：build:plugin、verify:plugin 通过；临时数据/仓库的真实 request→claim→bind→report 协议链确认 running/completed 关联独立卡片资源和正确快照。
- `pnpm smoke`、`git diff --check` 通过；后台测试 60 秒硬超时，没有超时。
- 内置 Chrome 的宽视图、420×900 窄栏验证卡片、点击详情、拒绝态；无横向溢出。使用禁止写入和执行的临时 SDK 夹具，临时服务与标签页已清理。
- 独立只读审查未发现阻断问题；按审查建议补充模板异常时拒绝回退的测试。
- **未覆盖**：未安装新版宿主插件，真实 Codex 聊天的 inline 展示与点击详情仍待验收。详见 [验收记录](../../acceptance/20261006-inline-report-card.md)，计划保留 active。
- 仓库无 ESLint/Prettier 配置，未声明相关检查通过。

## 变更统计

统计使用本轮修改前快照逐文件 `git diff --no-index --shortstat/--numstat`，新增文件与 `/dev/null` 比较；排除已有未提交改动、先前调研记录、历史记录自身，以及自动生成的插件/构建产物。5 张夹具截图按二进制记录，不计文本行数。

- **变更文件数**：27（22 个文本文件、5 张截图）。
- **文本新增**：+758。
- **文本删除**：-48。

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| extension/src/widget.mjs | 21 | 1 |
| extension/src/report-card.mjs | 28 | 6 |
| extension/src/plugin-server.mjs | 3 | 3 |
| mcp/src/register.ts | 3 | 3 |
| mcp/test/apps-report.test.ts | 2 | 1 |
| ui/test/report-card.test.mjs | 37 | 1 |
| scripts/verify-plugin.mjs | 38 | 4 |
| .claude-plugin/marketplace.json | 1 | 1 |
| extension/plugin-src/plugin.json | 1 | 1 |
| extension/plugin-src/.codex-plugin/plugin.json | 1 | 1 |
| extension/README.md | 8 | 3 |
| docs/native-execution-contract.md | 14 | 7 |
| docs/exec-plans/active/native-execution-report-card.md | 29 | 2 |
| docs/acceptance/20261006-inline-report-card.md | 37 | 0 |
| ui/src/App.tsx | 11 | 3 |
| ui/src/mcp/appsClient.ts | 71 | 5 |
| ui/src/state/BoardContext.tsx | 90 | 5 |
| ui/src/i18n/messages.ts | 19 | 0 |
| ui/src/styles.css | 12 | 0 |
| ui/test/native-execution.test.mjs | 1 | 1 |
| ui/src/components/ExecutionReportCard.tsx | 48 | 0 |
| ui/test/execution-report-card.test.mjs | 283 | 0 |
| docs/acceptance/20261006-inline-report-{running,completed,detail,refused,preview}.jpg（5 文件） | bin | bin |

## 后续事项

更新已安装插件到 0.3.17，并在加载新版的真实执行聊天验收“先显示卡片，点击后才打开详情”；旧会话记录不作为新版验收证据。不把本地夹具或卡片字段存在宣布为宿主显示通过。

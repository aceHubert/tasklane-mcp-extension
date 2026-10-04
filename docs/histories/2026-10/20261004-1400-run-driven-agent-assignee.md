## [2026-10-04 14:00 +0800] | 任务：Run Codex 自动标记 Agent 并移除手动指派

### 执行上下文

- **Agent ID**：`ZCode`
- **Base Model**：`new-provider/gpt-6.1-sol`
- **Runtime**：ZCode Desktop；macOS darwin 25.6.0 arm64；TypeScript/React/pnpm workspace
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main`，尚无首次提交，没有可用 HEAD 差异基线
- **关联计划**：[Run 驱动执行方标识](../../exec-plans/completed/run-driven-agent-assignee.md)

### 用户诉求

> 应该通过 Run Codex 操作来标识这个状态。

### 变更概览

**影响范围**：核心执行请求、UI 卡片/详情/新建表单、契约描述、测试、使用说明和插件版本。

- 新有效的 task_execution_request 在既有任务/请求事件事务中设置 assignee=agent，不额外调用 task_assign。
- 新建任务默认 human；卡片和详情执行方只读，删除 Assign to Agent / Reassign Human 入口，新建表单移除自动指派选项和对应双语文案。
- 执行态仍为 starting，只有目标聊天真实回执才 running/startedAt；投递拒绝或未知保持已持久化 Agent 意图，异常独立展示。
- 参数/看板/归档/执行忙守卫不更改标识；幂等重放和合并不会覆盖后续修改，不追加假指派事件。MCP task_assign 为已有调用者保留，仍是无启停副作用的元数据工具。
- 保留工作方式、模型目录、绑定、时间线、归档和现有会话打开逻辑。新增原子/无副作用/幂等/并发回归并修正拒绝后的执行态断言。
- 插件源 manifest、市场、MCP 服务和 App 版本同步 0.3.5，自包含产物通过既有流程生成；未安装、更新或重启用户宿主。

### 设计动机

独立指派只改标签，和实际 Run 意图割裂。把 Agent 标识与有效执行请求同一次锁内写入，
使 UI 与 Agent 使用同一规则，避免先改标识后请求失败的部分写入。标识表示用户请求
Agent 处理，不是执行证明。无数据格式变更、无旧任务自动重标或迁移；回滚只改源码，
不清理任务、聊天、分支或工作区。

### 验证结果

以下命令均单独设置 60 秒硬超时，超时终止对应进程组；最终全部通过、无超时。

| 命令 | 结果 |
| --- | --- |
| `pnpm build` | 通过 |
| `pnpm test` | **145/145 通过**，0 失败 |
| `pnpm smoke` | 通过，执行请求原子标记 Agent 的 stdio 检查 |
| `pnpm verify:twoproc` | 通过，临时双进程同请求合并及标识/并发编辑保留 |
| `pnpm --filter @tasklane/ui typecheck` | 通过 |
| `node --test ui/test/*.test.mjs` | **27/27 通过**，0 失败 |
| `pnpm build:ui` | 通过 |
| `pnpm build:plugin` / `pnpm verify:plugin` | 通过 |
| `git diff --check`、说明链接检查 | 通过 |

新增 core 回归确认：新建/人工流转保持 human；有效请求与 agent 同时落盘；无效/错板/
归档/无仓库不变；重放不覆盖显式 MCP 人工标识；新代次重新标 Agent；拒绝/未知不伪造运行；
两个引擎竞争只有一个请求，元数据不丢。UI 实际组件渲染覆盖 Human/Agent 卡片、窄详情和
宽抽屉，不存在手动指派控件；新建无 checkbox，UI 操作层不调用 task_assign。

**未覆盖场景**：遵循当前原生直接执行计划中停止模拟界面验收的要求，本轮未启动
浏览器 mock/临时服务，没有在真实 Codex 中代替用户点击 Run、创建聊天或打开会话。
协议/静态组件渲染不是原生 UI 实测。真实 Run 按钮投递仍需在目标宿主单独取证。
未改 Git/worktree 创建或 bridge 逻辑，不重复其专项验证。

### 变更统计

- **统计口径**：任务前存在大量他人暂存与未暂存改动且无有效 HEAD，以本次开始前源码
  快照逐文件执行 `git diff --no-index --shortstat` 与 `--numstat`；新增测试对比 `/dev/null`。
- **排除范围**：历史记录自身、已归档执行计划及自动生成插件产物单独列出，不计入源码
  数字汇总；保留其它任务的模型目录与轮询加载修复、不将其统计成本次工作。
  plugin-server 的基线按本次实际替换的版本和指派说明精确还原，不包含额外改动。
- **变更文件数（源码/配置/测试/使用说明）**：23
- **新增行数**：+189
- **删除行数**：−94

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/native-execution.ts` | 2 | 0 |
| `packages/core/test/native-execution.test.ts` | 3 | 1 |
| `packages/core/test/run-assignee.test.ts` | 111 | 0 |
| `mcp/src/register.ts` | 1 | 1 |
| `mcp/test/native-execution.test.ts` | 5 | 2 |
| `scripts/smoke.mjs` | 1 | 1 |
| `scripts/two-process-verify.mjs` | 1 | 1 |
| `ui/src/components/NewTaskForm.tsx` | 4 | 26 |
| `ui/src/components/TaskCard.tsx` | 0 | 5 |
| `ui/src/components/TaskDetail.tsx` | 2 | 11 |
| `ui/src/state/useTaskActions.ts` | 1 | 6 |
| `ui/src/i18n/messages.ts` | 4 | 14 |
| `ui/test/task-detail-controls.test.mjs` | 29 | 7 |
| `ui/test/native-execution.test.mjs` | 1 | 1 |
| `ui/README.md` | 1 | 1 |
| `README.md` | 3 | 2 |
| `WORKFLOW.md` | 7 | 7 |
| `docs/native-execution-contract.md` | 4 | 0 |
| `extension/src/plugin-server.mjs` | 3 | 2 |
| `extension/plugin-src/plugin.json` | 2 | 2 |
| `extension/plugin-src/.codex-plugin/plugin.json` | 2 | 2 |
| `ui/src/mcp/appsClient.ts` | 1 | 1 |
| `.claude-plugin/marketplace.json` | 1 | 1 |

### 修改文件

上表 23 个文件、新增 `docs/exec-plans/completed/run-driven-agent-assignee.md`，以及由构建流程
生成的 `plugins/tasklane/` server、widget、两份 manifest；产物未手改。未执行 git add/commit/push。

### 后续事项

本次功能与自动化交付完成；用户安装的插件和运行中面板更新状态未确认，需加载 0.3.5
才会生效。真实 Codex Run UI 验收继续归属既有[原生直接执行计划](../../exec-plans/completed/codex-direct-task-execution.md)。

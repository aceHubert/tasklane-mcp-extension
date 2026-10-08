# [2026-10-05 21:53 +0800] | 任务：实施 Review Binding 与多 Agent 执行上下文

### 执行上下文

- **Agent ID**：zcode
- **Base Model**：account:zai-individual-coding-plan/GLM-5.3
- **Runtime**：ZCode CLI（macOS arm64，Node.js 22）
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main（未提交，工作区另有前序任务的已暂存改动，见统计口径）
- **关联计划**：[docs/exec-plans/completed/review-binding-and-external-execution.md](../../exec-plans/completed/review-binding-and-external-execution.md)

### 用户诉求

> review-binding-and-external-execution.md 开始实施

按已入库执行计划完成 Review 流程全量实施：独立 `reviewBinding` / `reviewExecution`、
执行请求 `purpose` 分流、非 Codex `externalExecutionSession`、Review workspace 守卫、
多轮 Review 结论持久化与 revision/CAS、UI 与插件文档同步、存储 v6 迁移与整体验证。

### 变更概览

**影响范围**：`packages/core/`、`mcp/`、`ui/`、`scripts/`、`docs/`、`extension/plugin-src/`、`plugins/tasklane/`（生成产物）。

**主要操作**：

- **数据模型（v6）**：`work-item.ts` 新增 `ExecutionPurpose`、`ReviewBinding`、`ExternalExecutionSession`、
  `TaskReview/ReviewRound/ReviewUpdate`；`ExecutionRequest` 增加 `purpose` 与 review 请求的服务端解析
  `workspacePath`；`errors.ts` 新增 `REVIEW_WORKSPACE_REQUIRED/REVIEW_WORKSPACE_CONFLICT/REVIEW_STALE`。
- **存储迁移**：主文件 v5→v6（旧请求补 `purpose=implementation`、备份 `.v5.bak`），归档冷文件升级 v2
  （读取兼容 v1 并按实现语义补 purpose）；v1–v4 路径直达 v6；完整校验 review/绑定/外部会话字段与
  「实现与验收不得同聊天」存储级约束。
- **Core 状态机（native-execution.ts / engine.ts）**：request/claim/delivery/bind/report 全链路
  purpose 分流；review 请求仅 start/continue + existing，服务端解析唯一实现工作区（三来源互异即冲突）；
  review 绑定强制不同线程 + 同实现工作区；review running 开轮并置 reviewing，重复 running 不重复开轮；
  实现 running 在 Review 列把 changes_requested 推进 fixing；`task_review_update` revision/CAS 状态机
  （changes_requested/approved 须非空结论，reviewing/fixing 须真实 running 证据）；`bindExternal` 记录
  非 Codex 会话（opaque sessionId、Git 身份校验、force 覆盖与在途执行守卫）；engine 读取侧 Review
  惰性 pending 视图，moveTask 进列初始化。
- **MCP 契约**：`task_execution_request` 增加 `purpose`；新增 `task_execution_external_bind` 与
  `task_review_update`；smoke 扩展 Review 闭环 / 外部会话 / CAS 冒烟段。
- **UI**：host.ts 增加验收工作区预解析与 review 入口守卫；TaskDetail 新增 Review 区块
  （状态、轮次结论、待验收工作区、外部会话、首次模型选择、修改/复查提示词编辑器）；
  「标记完成」在 approved 后开放；继续修改走实现绑定、继续验收走 reviewBinding，
  无对应绑定隐藏入口；i18n 中英文同步。
- **插件与文档**：native-execution SKILL 增加 Review 会话协议章节；README 工具表与存储说明、
  WORKFLOW 新增 Review 自流转与跨 Agent 流程图、原生执行契约更新 purpose/新工具/v6 迁移；
  `pnpm build:plugin` 重新生成插件产物。

### 设计动机

实现与验收分离为两个执行上下文：`executionBinding` 语义保持不变，`reviewBinding` 独立记录
验收会话；两者共用 request/claim/bind/report 协议但由持久化 `purpose` 分流，回执不可写错执行状态。
Review 强制验收实现真实修改的同一工作区：无来源 / 多来源互异 / 复查漂移一律拒绝
（`board.repo` 只做仓库身份校验），避免 Reviewer 检查错误目录或为验收另建 worktree。
非 Codex 会话只用 provider-local opaque `sessionId` 记录事实，不产生 threadId 语义、深链或原生续接，
从类型、存储校验到 UI 逐层禁止互转。多轮结论全部留存，跨 Agent 更新以 revision/CAS 防静默覆盖；
`approved` 不自动移动 Done，最终业务流转保持显式。兼容性：v6 升级在文件锁内完成并生成
`.v5.bak`，归档冷文件同批升级 v2 使旧服务无法静默续写新语义数据；回滚需同时恢复主文件与
整个 `archive/`（详见契约文档「迁移和验收边界」）。

### 验证结果

- 命令与结果（全部通过）：
  `pnpm build`；`pnpm test`（311 pass / 0 fail，含新增 `packages/core/test/review-flow.test.ts` 9 项、
  `mcp/test/review-contract.test.ts` 2 项、`ui/test/review-controls.test.mjs` 8 项）；
  `pnpm smoke`（24 工具 + Review 闭环冒烟）；`pnpm verify:git`；`pnpm verify:twoproc`；
  `pnpm --filter @tasklane/ui typecheck`；`pnpm build:ui`；`pnpm build:plugin`；`pnpm verify:plugin`。
  `pnpm verify:bridge` 未执行：本次未改动 bridge（不适用）。
- 手工验证及环境：UI 侧为 esbuild 打包 + `renderToStaticMarkup` 的 SSR 渲染断言（窄栏参数与
  Review 区块分流、提示词默认值、标记完成门控）；存储/Git 验证使用临时数据目录与内存桩 Git，
  未操作用户真实看板或工作区。
- 未覆盖场景：Codex 原生宿主真实面板（create_thread 独立验收会话、多轮 verdict 端到端）与
  独立浏览器视觉验收未执行；通用 provider Review 适配器与非 Codex 自动 Resume 未实现。
  均已登记技术债。

### 变更统计

> 统计口径：工作区在任务开始前已有大量前序任务的已暂存（staged）改动；本次任务差异 =
> `git diff`（工作区 vs 暂存区：29 文件 +1862/−211）+ 本次新增未跟踪测试文件 3 个（+792）。
  执行计划文档为前一会话交付（未计入）；他人未跟踪文件 `fix-default-board-projectless-execution.md` 未触碰。

- **统计口径**：如上；合计 32 个文件，+2654 / −211。
- **变更文件数**：32
- **新增行数**：+2654
- **删除行数**：−211

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/native-execution.ts` | +525 | −37 |
| `ui/src/components/TaskDetail.tsx` | +200 | −5 |
| `packages/core/src/work-item.ts` | +130 | −0 |
| `scripts/smoke.mjs` | +120 | −2 |
| `packages/core/src/board-store.ts` | +176 | −18 |
| `ui/src/i18n/nativeMessages.ts` | +78 | −0 |
| `mcp/src/register.ts` | +60 | −0 |
| `ui/src/host.ts` | +73 | −3 |
| `packages/core/test/review-flow.test.ts`（新增） | +500 | −0 |
| `ui/test/review-controls.test.mjs`（新增） | +194 | −0 |
| `mcp/test/review-contract.test.ts`（新增） | +98 | −0 |
| `AGENTS.md` 及其余 20 个文件（engine/errors/状态层/MCP handlers/文档/插件产物等） | 合计 +490 | −146 |

### 修改文件

- `packages/core/src/`：`work-item.ts`、`board-store.ts`、`native-execution.ts`、`engine.ts`、`errors.ts`
- `packages/core/test/`：`review-flow.test.ts`（新增）、`store.test.ts`、`archive-cold-storage.test.ts`
- `mcp/src/`：`register.ts`、`handlers.ts`；`mcp/test/review-contract.test.ts`（新增）
- `ui/src/`：`host.ts`、`mcp/types.ts`、`state/nativeExecution.ts`、`state/useTaskActions.ts`、
  `components/TaskDetail.tsx`、`i18n/nativeMessages.ts`、`i18n/messages.ts`、`styles.css`
- `ui/test/`：`review-controls.test.mjs`（新增）、`task-detail-controls.test.mjs`
- `scripts/`：`smoke.mjs`、`verify-plugin.mjs`
- 文档：`docs/native-execution-contract.md`、`README.md`、`WORKFLOW.md`、
  `extension/plugin-src/skills/native-execution/SKILL.md`、`docs/exec-plans/tech-debt-tracker.md`、
  执行计划归档至 `docs/exec-plans/completed/`
- 生成产物（`pnpm build:plugin`）：`plugins/tasklane/kanban-widget.html`、`plugins/tasklane/server.mjs`、
  `plugins/tasklane/skills/native-execution/SKILL.md`

### 后续事项

- 技术债（见 `docs/exec-plans/tech-debt-tracker.md`）：原生宿主与独立浏览器的 Review 端到端/视觉验收；
  通用 provider Review 适配器与非 Codex 自动 Resume；review blocked 的直接复用路径评估；
  导出报告的 Review 轮次维度。

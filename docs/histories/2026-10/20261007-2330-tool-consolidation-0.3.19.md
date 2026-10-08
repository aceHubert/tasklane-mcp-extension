## [2026-10-07 23:30 +0800] | 任务：工具契约收敛应对宿主 20 工具截断（0.3.19）

### 执行上下文

- **Agent ID**：zcode
- **Base Model**：account:zai-individual-coding-plan/GLM-5.3
- **Runtime**：ZCode 桌面会话（本仓库工作区）
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main（工作区含会话前未提交改动，未执行 git add/commit）
- **关联计划**：[docs/exec-plans/active/tool-consolidation-under-host-cap.md](../exec-plans/active/tool-consolidation-under-host-cap.md)

### 用户诉求

> Codex 桌面宿主每个 MCP 服务只向模型公布按名称排序的前 20 个工具，`task_review_update`
> 等关键工具在所有会话不可调用（证据：docs/acceptance/20261007-tasklane-tool-discovery.md）。
> 用户逐项拍板合并/去除方案：`task_review_update` 并入 `task_update action=review`；全部
> `task_execution_*` 合并为单工具 `task_execution`（action 分发）；`task_assign` 并入
> `task_update action=assign`；删除 `task_execution_recovery_request`（UI 直发核对消息）；
> `task_execution_recover` 重定义为 app-only 人工解除等待；`task_export/dir_list/model_list/
> task_delete/task_archive_done` 标 app-only；`task_archive/task_restore` 维持独立。

### 变更概览

**影响范围**：`packages/core/`、`mcp/`、`ui/`、`scripts/`、`extension/`、`docs/`。

**主要操作**：

- **core**：删除 `requestRecovery`；`recover()` 重写为 `release()`（人工解除：仅等待态可解除、
  非空原因、幂等重放，遗留 pending recoveryCheck 随解除关闭）；`recovery` 记录新增
  `releasedBy: 'user'`（checkId 变可选）；存储校验同步放宽；`engine.releaseExecution` 委托。
- **mcp**：`task_update` 复合（update/assign/review 分发重载）+ `task_execution` 复合
  （request/delivery/claim/bind/external_bind/report 六分支，request 子动作改名
  `requestAction`）；app-only `_meta` 标注 6 个 UI 专用工具；新 `task_execution_recover`
  （app-only 人工解除）。扁平 zod schema（SDK 仅公布 object 形状，union/superRefine 会清空
  公示字段），分支必填在 handler 层校验，引擎校验全部保留。
- **UI**：执行链调用点全部改 action 形态；核对消息去工具化（SDK 直发）；新增「解除等待」
  按钮 + 确认对话框（native.release.* 文案）；全部接收 Agent 提示词与技能文档改用新契约。
- **scripts**：smoke/verify-plugin 全面改写并新增 app-only 可见性与工具数断言。
- **版本与文档**：0.3.18 → 0.3.19（plugin.json×2、marketplace.json、plugin-server、widget
  URI v0319）；README/AGENTS.md/WORKFLOW/native-execution-contract/技能同步；技术债登记
  宿主截断、复合 schema、task_export 客户端化三项。

### 设计动机

宿主截断在插件侧不可配置，唯一可控手段是把模型可见工具压到 ≤20。收敛后 26 → 18 注册、
11 模型可见、7 app-only（`visibility:["app"]` 机制已被 tasklane_host_info 验证）。恢复流程
的 Agent 观测举证被人工解除取代：观测者就是用户本人，守卫收敛为等待态 + 非空原因 + 幂等。
执行状态仍只由真实回执或人工解除驱动，`task_update` 不承载执行状态写入。schema 用扁平
strict object 是 SDK `normalizeObjectSchema` 行为所迫（union/ZodEffects 公示为空对象）。
破坏性变更：旧工具名调用将返回 unknown tool；checkId/purpose=status 审计能力随旧核对
流程移除（已登记技术债）。无存储格式迁移，回滚 = git 回退工作区。

### 验证结果

- `pnpm --filter @tasklane/core --filter @tasklane/mcp run build`：通过。
- `pnpm test`：290/290 通过（恢复套件按新契约重写，状态核对套件随功能删除）。
- `pnpm smoke`：SMOKE PASSED（84 项检查，含 16 工具与 app-only 可见性断言）。
- `pnpm --filter @tasklane/ui typecheck` + `pnpm build:ui`：通过。
- `pnpm build:plugin` + `node scripts/verify-plugin.mjs`：plugin smoke ALL PASS；
  对 `plugins/tasklane/server.mjs` 实测握手：注册 18、模型可见 11、app-only 7，版本 0.3.19。
- 未执行：浏览器窄栏/宽视图/断连与解除等待按钮的视觉验收；Codex 原生宿主重装 0.3.19 后
  用 `task_update action=review` 补交 TASK-112 结论的端到端验收（需用户重装插件）。

### 复核修复补录（2026-10-08）

独立验收会话复核发现 4 项同步遗漏，已全部修复并全量回归：

- **A** `scripts/two-process-verify.mjs`：全部调用改 `task_update action=*` /
  `task_execution action=*`（request 子动作 `requestAction`），`pnpm verify:twoproc` PASSED。
- **B** `ui/test/native-execution.test.mjs`：桩按 `args.action` 分流；核对用例重写为零 MCP
  写入的 SDK 直发流程；新增 `releaseWaitingExecution`（app-only 解除等待）用例；
  提示词断言改新契约；`appsClient.ts` APP_VERSION 升 0.3.19。UI 测试 89/89。
- **C** 可见文本残留清理：`plugin-server.mjs` instructions（模型可见）、`engine.ts` 错误文案、
  `register.ts` runId 描述、`mcp/package.json` 描述、`scripts/qa-agent.mjs` 白名单。
- **D** 口径统一：`action` 必填（schema 显式判别），README 与执行计划同步修正。

回归命令与结果：`pnpm build` ✓、`pnpm test` 290/290 ✓、`pnpm smoke` PASSED、
`pnpm verify:git` PASSED、`pnpm verify:twoproc` PASSED、UI 测试 89/89 ✓、
`pnpm build:plugin` + `verify:plugin` ALL PASS ✓。

用户复核另指出两项遗留小项（2026-10-08 二次修复，全量回归同上通过）：

- `native-execution.ts` external_bind 错误文案残留 `task_execution_bind` → 改
  `task_execution action=bind`；`register.ts` requestAction 的 describe 同步去掉旧工具名引用
  （其余命中均为内部注释，保留历史语境）。
- 解除等待的活动摘要由中文恢复引擎英文惯例（引擎层不走 i18n，与旧恢复文案一致）；
  UI 解除原因改经 `t('native.release.reason')` 本地化（zh/en 键新增），英文界面不再显示中文。
- 按用户决定移除全部旧数据兼容层（真实看板数据中 recoveryCheck/recovery/checkId 记录为 0）：
  删除 `supersedeCheck` 及 8 处调用、`ExecutionRecoveryCheck`/`ExecutionThreadObservation` 类型、
  存储层 recoveryCheck 校验块与 recovery.checkId 宽容（收紧为 releasedBy='user' 唯一形态）、
  `execution_recovery_requested/checked` 事件类型与 UI 映射、TaskDetail 核对徽标及
  `native.recovery.check.*` 键、core 遗留标记用例。回归：test 289/289（-1 为删除的遗留用例）、
  UI 89/89、smoke/twoproc/plugin 全过。

### 变更统计

- **统计口径**：会话开始时工作区已含未提交改动（验收文档、历史等），以下为全工作区（含 2026-10-08 复核修复）
  `git diff --shortstat` / `--numstat`，含此前未提交内容，未做拆分。
- **变更文件数**：47（tracked diff）；另有 6 个新增未跟踪文件（本历史、执行计划、验收记录等）。
- **行数变更**：+1,289 / −1,772（tracked diff 汇总，含 2026-10-08 复核修复）。

# [2026-10-03 21:57 +0800] | 任务：实现任务归档功能

### 执行上下文

- **Agent ID**：ZCode
- **Base Model**：zai-api/GLM-5.3
- **Runtime**：ZCode 桌面会话（macOS darwin 25.6.0 arm64）
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：仓库尚无提交（全部文件处于已暂存待首次提交状态，`git log` 为空）
- **关联计划**：[completed/task-archiving.md](../../exec-plans/completed/task-archiving.md)

### 用户诉求

> 实施 task-archiving.md（docs/exec-plans/active/task-archiving.md，实施后已
> 归档）；会话中途补充：为另一会话（sess_6319197f…）的中英文切换方案制定
> 执行计划文档，且本功能 UI 文案按该 i18n 方案编写。

### 变更概览

**影响范围**：`packages/core/`、`mcp/`、`ui/`、`scripts/`、`extension/src/`、
`plugins/`（构建产物）、`README.md`、`WORKFLOW.md`、`docs/exec-plans/`。

**主要操作**：

- **核心与存储**：`WorkItem.archivedAt?` 可选字段；存储升级 v3（v1 链式
  迁移、`.v1.bak`/`.v2.bak` 备份、损坏字段 `STORE_ERROR`）；`listTasks`
  归档过滤（存储层不设默认）；新增 `mutateTaskWithEvent`（任务+事件原子
  提交）与 `mutateTasksWhere`（锁内批量原子修改）。
- **引擎规则**：`archiveTask` / `restoreTask` / `archiveDoneTasks`；幂等
  （`changed` 标志）；归档守卫在事务内基于磁盘最新状态拒绝 update/move/
  assign（新错误码 `TASK_ARCHIVED`）；`boardList` 新增 `archivedCount`，
  counts/total 排除归档；`archived`/`restored` 时间线事件。
- **MCP 契约**：新工具 `task_archive` / `task_restore` / `task_archive_done`；
  `task_list` 新增 `archive: active|archived|all`（默认 active）。
- **UI**：Header「已归档」入口（徽标计数）；Done 卡片「归档」；窄栏 Done
  页与宽视图 Done 列头「归档全部已完成（N）」（内联确认）；归档视图
  （搜索 + 归档时间倒序 + 恢复）；归档详情只读 + 恢复 CTA；文案全部走
  i18n 字典（en/zh 全覆盖）；切换看板自动关闭并作废在途归档请求。
- **验证脚本**：smoke 增加归档链路断言；two-process-verify 增加归档并发
  （P4：跨进程守卫、双进程批量不重复、并发回退无中间态）；
  verify-plugin 工具清单扩至 17；插件说明同步。
- **文档**：README 工具表与 WORKFLOW §6 归档语义；执行计划归档；
  另按用户中途要求产出 [active/ui-i18n-zh-en.md](../../exec-plans/completed/ui-i18n-zh-en.md)。

### 设计动机

- 归档是展示口径问题而非业务状态：用可选 `archivedAt` 保留五个状态与
  Done 完成语义，恢复不产生额外流转。
- 守卫必须在存储事务函数内执行（磁盘最新状态），进程内锁与跨进程文件锁
  顺序沿用现有 `taskLocks → 文件锁`；批量只持文件锁且无异步间隙，不会
  与单任务顺序构成环。
- 存储层 `listTasks` 不设归档默认：ID 分配、归属校验、计数等内部处理需要
  完整数据；业务默认 `active` 在引擎层注入，归档任务不会从内部处理消失。
- 批量归档目标选取放进 `mutateTasksWhere` 锁内回调：并发回退到 review 的
  任务按提交时最新状态跳过，失败无部分写入。
- 与并行 i18n 会话协作：归档文案直接以 i18n 键追加 `messages.ts`（双方均
  为追加式改动），组件层不写死文案，避免二次返工与混排回潮。

### 验证结果

- 命令与结果（均通过）：
  `pnpm build`；`pnpm test`（118 通过 / 0 失败，归档专项 17 例）；
  `pnpm smoke`（SMOKE PASSED，归档链路 18 项断言）；
  `pnpm verify:twoproc`（TWO-PROCESS VERIFY PASSED，P4 归档并发 5 项）；
  `pnpm --filter @tasklane/ui typecheck`；`pnpm build:ui`；
  `pnpm build:plugin`；`pnpm verify:plugin`（plugin smoke: ALL PASS）。
  全部在 60 秒硬超时内完成；集成验证使用临时数据目录与临时 Git 仓库。
- 手工验证（独立浏览器模式，bridge 7461 + 临时 TASKLANE_HOME，内置
  Chromium）：窄栏 420px——Done 批量归档条（数量/禁用态/内联确认）、
  单卡归档、归档徽标、归档视图（搜索空态、恢复、详情只读、恢复后解锁、
  toast）；宽视图 1280px——Done 列头批量归档、恢复后计数与卡片刷新；
  中英双语切换下归档文案均正确。验收中发现并修复：human 指派的 done
  卡片最初缺少「归档」入口（TaskCard 分支遗漏）。
- 未覆盖场景：Codex 原生宿主面板内的归档交互人工验收未执行（本会话无
  Codex 宿主；`verify:plugin` 已覆盖工具面），沿用原生执行计划既有验收债；
  归档列表分页与大数据量下的存储体积不在本期范围（计划已明确）。

### 变更统计

- **统计口径**：仓库无任何提交（无 HEAD 基线），且与并行会话（原生执行、
  i18n 等）改动在部分文件上交错，无法按文件拆分归属。新增文件用
  `git diff --no-index /dev/null <file>` 精确统计；其余修改文件给出暂存后
  的未暂存总量（`git diff --shortstat`，含并行任务改动，仅作参考）。
  历史记录自身不计入。

- **参考总量（未暂存，含并行任务）**：53 files, +3455 −1367
- **本任务新增文件数**：3（不含历史记录与归档后的计划副本）
- **本任务新增行数**：+314

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/components/ArchiveAllButton.tsx` | 52 | 0 |
| `ui/src/components/ArchivedView.tsx` | 122 | 0 |
| `docs/exec-plans/active/ui-i18n-zh-en.md` | 140 | 0 |

### 修改文件

- `packages/core/src/`：`work-item.ts`、`board-store.ts`、`engine.ts`、`errors.ts`
- `packages/core/test/`：`store.test.ts`、`engine.test.ts`
- `mcp/src/`：`register.ts`、`handlers.ts`；`mcp/test/tools.test.ts`
- `ui/src/`：`App.tsx`、`styles.css`、`i18n/messages.ts`、
  `state/BoardContext.tsx`、`state/useTaskActions.ts`、
  `components/{TaskCard,TaskDetail,TaskList,BoardWide,AppHeader,icons}.tsx`
- `scripts/`：`smoke.mjs`、`two-process-verify.mjs`、`verify-plugin.mjs`、`build-plugin.mjs`
- `extension/src/`：`plugin-server.mjs`、`widget.mjs`
- 文档：`README.md`、`WORKFLOW.md`、`docs/exec-plans/active/task-archiving.md`（→ `completed/`）

### 后续事项

- Codex 原生面板内归档交互人工验收：随
  [原生执行计划](../../exec-plans/completed/codex-native-execution-bridge.md)
  的原生验收债一并执行（技术债表已有登记，不重复立行）。
- 归档列表分页与存储体积优化：本期明确不做，需要时另立计划。

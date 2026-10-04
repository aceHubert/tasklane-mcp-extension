## [2026-10-03 14:22 +0800] | 任务：实施多仓库看板隔离

### 执行上下文

- **Agent ID**：codex（ZCode 会话内实施）
- **Base Model**：GLM-5.3（account:zai-individual-coding-plan）
- **Runtime**：ZCode 桌面端，macOS darwin 25.6.0 arm64
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main（仓库尚无任何提交，HEAD 指向未生成的 main；全部文件处于已暂存/工作区状态）
- **关联计划**：`docs/exec-plans/completed/multi-repo-board-isolation.md`（已归档）

### 用户诉求

> 实施 multi-repo-board-isolation.md

按执行计划交付多仓库看板管理能力：一个实例管理多个本地 Git 仓库，
界面可添加与切换仓库，任务按看板隔离，Git 上下文按任务所属看板路由，
保留旧数据与并发安全。

### 变更概览

**影响范围**：`packages/core/`、`mcp/`、`ui/`、`scripts/`、`README.md`、`WORKFLOW.md`、`ui/README.md`、`extension/README.md`

**主要操作**：

- **核心归属模型（P1）**：`WorkItem` 增加持久化必填 `boardId`；`Board` 增加仓库身份键
  `repoKey`；存储升级 v2（锁内迁移 + `.v1.bak` 备份 + 歧义明确报错）；
  `registerBoard` 锁内按 repoKey 去重（同仓库子目录/符号链接/worktree 幂等）；
  新增 `withTaskLock` 跨进程任务锁；错误码新增 `BOARD_NOT_FOUND` / `BOARD_MISMATCH`。
- **Git 能力（P1）**：`validateRepoForBoard` 注册校验（路径/工作区/裸仓库/提交/基线分支，
  不受 `TASKLANE_GIT=off` 影响）；worktree 复用前核验仓库身份与分支，不匹配明确报错。
- **引擎（P1/P2）**：`boardList` 按任务归属统计；`createTask`/`listTasks` 多看板必须
  指定 `boardId`（单看板自动解析）；`getTask`/`updateTask`/`moveTask`/`assignTask`
  归属校验；`assign`/`refreshChanges` 按任务所属看板路由 Git；并发指派在任务锁内
  重查执行。
- **MCP 契约（P2）**：新增 `board_create`（第 8 个工具）；全部任务工具增加可选
  `boardId` 参数与 zod schema；handlers 纯函数层同步。
- **UI（P3）**：`BoardContext` 重构为多看板（boards 列表 + 当前选择 localStorage 持久化
  + 请求代次竞态隔离 + 切换清空）；`AppHeader` 仓库选择器与 ⊞ 添加入口（选择框
  max-width 280px，按用户中途反馈加入）；新增 `AddBoardForm`（失败保留输入内联报错）；
  视图树以 `boardId` 为 key 重置局部状态；`useTaskActions`/`NewTaskForm`/`BoardWide`
  拖拽写操作携带 boardId。
- **验证脚本（P4）**：smoke 扩展为 8 工具 + 多看板契约错误通道；git-verify 新增
  S5 双仓库隔离 / S6 注册去重与非法输入 / S7 双引擎并发指派 / S8 错误绑定核验；
  two-process-verify 新增双进程并发注册与多看板归属创建。
- **文档（P5）**：README / WORKFLOW / ui README / extension README 同步多仓库用法
  与 8 工具契约；计划归档至 `completed/`。

### 设计动机

- 多看板共存于同一 `board.json`（version 2），任务显式归属；任务 ID 全局唯一，
  避免 Agent 省略 `boardId` 时产生歧义。列表/创建省略 `boardId` 仅在单看板时
  自动解析，多看板强制指定，不悄悄操作第一个看板。
- 仓库去重用 git common dir 作为身份键：子目录、符号链接与 worktree 注册时
  统一归位主仓库；旧看板首次注册新仓库时回填缺失的 repoKey。
- 迁移在文件锁内重读最新数据后执行并保留原始备份；v1 多看板歧义、未知版本、
  任务悬空引用一律明确报错，不通过清空数据掩盖问题。
- 浏览器选择是客户端状态（localStorage），服务端无全局"当前仓库"；写操作由
  UI 携带任务 boardId + 服务端 BOARD_MISMATCH 双重校验，覆盖快速切换与陈旧卡片。
- 兼容与回滚：v1 数据自动升级且保留 `board.json.v1.bak`；升级后新增任务需单独
  核对后再考虑回滚（不可直接用备份覆盖，见计划 §9）。

### 验证结果

- 命令与结果（全部通过，每次后台命令均带 60s 硬超时）：
  - `pnpm build` ✅
  - `pnpm test` ✅ 39/39（core 规则/存储并发/迁移/注册去重/任务锁 + mcp 契约含多看板）
  - `pnpm smoke` ✅（8 工具、board_create 真实临时仓库、VALIDATION/BOARD_NOT_FOUND/BOARD_MISMATCH 错误通道）
  - `pnpm verify:git` ✅ S1–S8（含 A/B worktree 与摘要隔离、注册去重、双引擎并发指派单工作区、错误绑定不写错仓库）
  - `pnpm verify:twoproc` ✅（双进程并发注册同一看板、多看板创建 ID 唯一）
  - `pnpm verify:bridge` ✅
  - `pnpm --filter @tasklane/ui typecheck` ✅、`pnpm build:ui` ✅
- 手工验证及环境（独立浏览器模式，bridge `127.0.0.1:7455` + 临时数据目录 +
  两个临时 Git 仓库 main/develop 基线，内置 Chrome 工作流实测）：
  - 360px / 420px / 1280px 视口：选择器、添加表单、列表布局无重叠溢出
    （1280px 下第 5 列沿用既有横向滚动设计）；
  - 添加仓库 A/B 成功自动切换、A 计数正确、B 不串入 A 的任务；
  - 重复添加已注册仓库幂等切回；添加失败（不存在路径）内联报错、
    输入保留、不切换看板；
  - 快速 A→B→A 切换后停留与计数正确；刷新页面恢复选择；
  - 两个标签页分别选择不同看板，运行时互不影响（同一浏览器共享 localStorage
    属预期；跨浏览器独立选择由"服务端无全局状态"保证）；
  - 停止 bridge 出现断连横幅并保留缓存；重启 bridge 自动重连、
    看板列表与选择恢复。
- 未覆盖场景：Codex 原生宿主侧栏内的多仓库验收（宿主接入本身未落地，属后续工作）；
  多用户/权限隔离（明确范围外）。

### 变更统计

> 统计口径：仓库尚无提交，`git diff`（工作区 vs 暂存区）为本次任务近似基线；
> 排除并行品牌重命名任务的专属文件（`canvas/`、`plugins/`、
> `extension/src/`）；`ui/src/components/AddBoardForm.tsx` 为新增未跟踪文件单独计入。
> 少量 UI 文件的行数含并行改名的重叠改动（约 ±50 行）。

- **变更文件数**：28（含新增 `ui/src/components/AddBoardForm.tsx`）
- **新增行数**：约 +1870
- **删除行数**：约 -275

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/board-store.ts` | 249 | 34 |
| `packages/core/src/engine.ts` | 138 | 16 |
| `packages/core/src/git.ts` | 110 | 8 |
| `packages/core/src/work-item.ts` | 8 | 1 |
| `packages/core/src/errors.ts` | 2 | 0 |
| `packages/core/test/store.test.ts` | 212 | 38 |
| `packages/core/test/engine.test.ts` | 126 | 13 |
| `mcp/src/handlers.ts` | 32 | 10 |
| `mcp/src/register.ts` | 38 | 8 |
| `mcp/test/tools.test.ts` | 94 | 1 |
| `ui/src/state/BoardContext.tsx` | 155 | 16 |
| `ui/src/state/useTaskActions.ts` | 27 | 12 |
| `ui/src/components/AppHeader.tsx` | 40 | 3 |
| `ui/src/components/AddBoardForm.tsx`（新增） | ≈120 | — |
| `ui/src/App.tsx` | 11 | 1 |
| `ui/src/components/TaskList.tsx` | 27 | 4 |
| `ui/src/components/NewTaskForm.tsx` | 19 | 9 |
| `ui/src/components/TaskDetail.tsx` | 14 | 11 |
| `ui/src/components/BoardWide.tsx` | 6 | 2 |
| `ui/src/styles.css` | 13 | 1 |
| `scripts/git-verify.mjs` | 167 | 7 |
| `scripts/smoke.mjs` | 79 | 12 |
| `scripts/two-process-verify.mjs` | 62 | 7 |
| `README.md` | 47 | 26 |
| `WORKFLOW.md` | 66 | 29 |
| `ui/README.md` | 4 | 3 |
| `extension/README.md` | 3 | 2 |

### 修改文件

- `packages/core/src/{board-store,engine,git,work-item,errors}.ts`
- `packages/core/test/{store,engine}.test.ts`
- `mcp/src/{handlers,register}.ts`、`mcp/test/tools.test.ts`
- `ui/src/App.tsx`、`ui/src/state/{BoardContext,useTaskActions}.tsx|ts`、
  `ui/src/components/{AppHeader,AddBoardForm,NewTaskForm,TaskList,TaskDetail,TaskCard,BoardWide}.tsx`、`ui/src/styles.css`
- `scripts/{smoke,git-verify,two-process-verify}.mjs`
- `README.md`、`WORKFLOW.md`、`ui/README.md`、`extension/README.md`
- `docs/exec-plans/completed/multi-repo-board-isolation.md`（归档并更新进度）

注：`ui/src/components/TaskCard.tsx` 的 4/4 行改动为并行重命名任务所属，
仅因其调用 `useTaskActions` 新签名被动适配，未改动其逻辑。

### 后续事项

- Codex 原生宿主接入与侧栏内多仓库验收：属宿主集成后续工作（见
  `extension/README.md` 与根 README 已知限制）。
- 仓库删除、任务跨仓库迁移、远程克隆、自动合并：范围外，需要时另立计划；
  未登记为技术债（按计划 §12 约定）。
- 实施期间发现工作区存在并行的品牌/术语重命名改动（`codex` → `agent`、
  TaskLane 品牌调整，含 `docs/exec-plans/active/project-scoped-board-entrypoints.md`
  新计划），本任务与其共存实施、未回退；`agent/TASK-xxx` 分支前缀与
  `ASSIGNEES = ['human','agent']` 以该并行改动后的工作区为准。

## [2026-10-03 18:12 +0800] | 任务：清理 codex-kanban / CODEX 前缀命名残留

### 执行上下文

- **Agent ID**：`zcode`
- **Base Model**：`zai-api/GLM-5.3`
- **Runtime**：`ZCode 桌面端（darwin 25.6.0 arm64）`
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：`main`（仓库尚无提交，分支为初始 unborn 状态，`git rev-parse HEAD` 失败属预期）
- **关联计划**：无（单点清理任务，未达创建执行计划门槛）

### 用户诉求

> 仓库里仍有大量 `codex-kanban` / `CODEX` 前缀相关说明。除文档中说明 Codex 侧边栏语义的内容外，其余都不属于 codex-kanban 命名，都需要修改掉。

### 变更概览

**影响范围**：`packages/core/`、`mcp/`、`ui/`、`extension/`、`scripts/`、`docs/`、根文档。

**主要操作**：

- **MCP 工具描述**：`mcp/src/register.ts` 中 `task_update` / `task_assign` 描述与 `assignee` 参数 describe 由 "codex / Assign to Codex" 对齐为 "agent / Assign to Agent"（枚举本体已是 `z.enum(['human','agent'])`，仅文案残留）。
- **核心注释**：`packages/core/src/engine.ts`、`mcp/src/handlers.ts` 的 "Codex agent" 注释改为 "编码 agent / agent"。
- **UI 本地存储键**：`ck-theme`（`ui/index.html`、`ui/src/components/AppHeader.tsx`）→ `tasklane-theme`；`ck-board-id`（`ui/src/state/BoardContext.tsx`）→ `tasklane-board-id`。旧键不做迁移读取，主题偏好与上次看板选择会回到默认值。
- **脚本**：`scripts/git-verify.mjs` 错绑分支由 `codex/` 前缀改为与 `packages/core/src/git.ts` 一致的 `agent/`；`scripts/qa-agent.mjs` 头注释改为 "模拟编码 agent"。
- **extension**：`extension/src/plugin-server.mjs` 注释对齐；`extension/tools/package-lock.json` 包名 `@codex-kanban/build-tools` → `@tasklane/build-tools`（与 package.json 一致）。
- **根文档**：`AGENTS.md` 项目名改为 TaskLane（tasklane）、环境变量段全部改为 `TASKLANE_*` 与 `~/.tasklane`（补记 `TASKLANE_ALLOWED_ORIGINS`）、多仓库计划链接修正到 `completed/`（原 `active/` 链接已失效）；`README.md`、`WORKFLOW.md`、`ui/README.md` 中 "Assign to Codex / Codex agent / 指派 codex" 等 UI 动作与枚举表述对齐为 Agent。
- **执行计划模板**：`docs/exec-plans/templates/execution-plan.md` 验证命令由 `npm run typecheck -w @codex-kanban/ui` 修正为 `pnpm --filter @tasklane/ui typecheck` 等实际命令。
- **设计交付文档**：`docs/Codex_Kanban_MCP_Extension_项目计划与UI设计交付说明.md` 重命名为 `docs/TaskLane_MCP_Extension_项目计划与UI设计交付说明.md`，正文中 UI 动作名、assignee 枚举、执行状态文案（"Assign to Codex"→"Assign to Agent"、"human | codex"→"human | agent"、"Codex Running/assigned/activity"→"Agent …"）与实现对齐。
- **构建产物刷新**（源在 gitignore 之外的 `plugins/tasklane/`）：`pnpm build:plugin` 重新生成 `server.mjs`、`kanban-widget.html`，携带新的工具描述与存储键；`ui/dist`、`extension/dist` 为 gitignore 产物，由 `pnpm build:ui` / `build:plugin` 一并刷新（旧产物中的 "Codex Kanban" 标题随之消除）。

### 设计动机

- 代码与数据早已迁移到 tasklane / agent 命名（枚举、环境变量、分支前缀），残留集中在描述文案、注释、存储键、lock 包名与文档，容易误导后续维护与接入方。
- 保留边界：说明 **Codex 宿主 / 侧边栏 / 原生面板 / Codex Session** 语义的表述（README 架构图与里程碑、WORKFLOW 宿主验收段、extension/README、`.codex-plugin/` 宿主目录约定、manifest 中 "into the Codex sidebar" 描述等）不动；`packages/core/src/board-store.ts` 的 `'codex' → 'agent'` 旧数据读取兼容逻辑属既有数据语义，保留。
- `docs/histories/` 与 `docs/exec-plans/completed/` 是时间点存档（记录当时的真实路径与环境变量名），按规范不改写。
- 存储键直接换新不写迁移：0.x 本地工具，旧键仅存主题偏好与看板选择，丢失后自动回退默认值，代价可接受。

### 验证结果

- 命令与结果（均在仓库根执行，通过）：
  - `pnpm build`：tsc -b 构建通过。
  - `pnpm test`：45/45 通过（core + mcp 单测）。
  - `pnpm smoke`：SMOKE PASSED（stdio 工具链路，覆盖工具描述改动后的契约）。
  - `pnpm verify:git`：GIT VERIFY PASSED（临时 Git 仓库，含 `agent/` 分支前缀的 S8 错绑降级用例）。
  - `pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui`：通过；`ui/dist` 标题为 TaskLane，bundle 含 `tasklane-theme` 且无 `ck-theme`。
  - `pnpm build:plugin`、`pnpm verify:plugin`：构建与插件契约验证通过（9 tools + widget）。
- 手工验证及环境：grep 全仓复查，除 `docs/histories/`、`docs/exec-plans/completed/` 存档与 board-store 数据兼容逻辑外，无 `codex-kanban` / `CODEX_KANBAN` / `ck-` 前缀残留。
- 未覆盖场景：未在 Codex 原生宿主内重新验收（本次未改宿主契约面，仅文案与存储键）；浏览器端旧存储键迁移未实测（按设计不迁移）。

### 变更统计

> 仓库尚无提交，无 `HEAD` 基线；工作区相对暂存区的 diff 混有此前任务的未暂存改动，无法整段归属本任务。以下为本任务实际触碰的文件清单，行数为 `git diff --numstat -- <files>` 的上界参考（部分文件含先前未暂存改动）。历史记录自身不计入。

- **统计口径**：任务文件范围如上「变更概览」；上界汇总约 17 个源码/文档文件 + 1 个重命名的交付文档 + 2 个重建的插件产物。
- **变更文件数**：20（含重命名 1、重建产物 2）
- **新增行数**：约 +570（上界，含先前未暂存改动）
- **删除行数**：约 -210（上界，同上）

| 文件 | 新增 | 删除 | 备注 |
| --- | ---: | ---: | --- |
| `AGENTS.md` | 3 | 3 | |
| `README.md` | 31 | 11 | 含先前未暂存改动 |
| `WORKFLOW.md` | 50 | 31 | 含先前未暂存改动 |
| `ui/README.md` | 1 | 1 | |
| `docs/exec-plans/templates/execution-plan.md` | 2 | 2 | |
| `docs/TaskLane_MCP_Extension_项目计划与UI设计交付说明.md` | — | — | 由 `Codex_Kanban_…` 重命名 + 约 25 处文案对齐 |
| `mcp/src/register.ts` | 17 | 3 | 含先前未暂存改动 |
| `mcp/src/handlers.ts` | 102 | 2 | 含先前未暂存改动 |
| `packages/core/src/engine.ts` | 22 | 9 | 含先前未暂存改动 |
| `ui/src/mcp/appsClient.ts` | 4 | 4 | |
| `ui/src/styles.css` | 306 | 103 | 含先前未暂存改动 |
| `ui/src/state/BoardContext.tsx` | 19 | 7 | 含先前未暂存改动 |
| `ui/src/components/AppHeader.tsx` | 53 | 29 | 含先前未暂存改动 |
| `ui/index.html` | 2 | 2 | |
| `scripts/git-verify.mjs` | 1 | 1 | |
| `scripts/qa-agent.mjs` | 1 | 1 | |
| `extension/src/plugin-server.mjs` | 6 | 3 | 含先前未暂存改动 |
| `extension/tools/package-lock.json` | 2 | 2 | |
| `plugins/tasklane/server.mjs` | 29 | 29 | build:plugin 重建 |
| `plugins/tasklane/kanban-widget.html` | 13 | 17 | build:plugin 重建 |

### 修改文件

- `AGENTS.md`、`README.md`、`WORKFLOW.md`、`ui/README.md`
- `docs/exec-plans/templates/execution-plan.md`
- `docs/TaskLane_MCP_Extension_项目计划与UI设计交付说明.md`（重命名）
- `mcp/src/register.ts`、`mcp/src/handlers.ts`、`packages/core/src/engine.ts`
- `ui/index.html`、`ui/src/styles.css`、`ui/src/state/BoardContext.tsx`、`ui/src/components/AppHeader.tsx`、`ui/src/mcp/appsClient.ts`
- `scripts/git-verify.mjs`、`scripts/qa-agent.mjs`
- `extension/src/plugin-server.mjs`、`extension/tools/package-lock.json`
- `plugins/tasklane/server.mjs`、`plugins/tasklane/kanban-widget.html`（构建产物重建）

### 后续事项

- 无。存档文档（`docs/histories/`、`docs/exec-plans/completed/`）中的旧命名按规范保留，不作为技术债。

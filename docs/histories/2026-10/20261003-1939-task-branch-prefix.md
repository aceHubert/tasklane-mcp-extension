## [2026-10-03 19:39 +0800] | 任务：任务分支前缀改为 tasklane/

### 执行上下文

- **Agent ID**：`zcode`
- **Base Model**：`zai-api/GLM-5.3`
- **Runtime**：`ZCode 桌面端（darwin 25.6.0 arm64）`
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：`main`（仓库尚无提交，unborn 初始状态）
- **关联计划**：无（单点命名调整）

### 用户诉求

> 把分支前缀修改为 tasklane/（此前任务自动分支为 `agent/TASK-xxx-<slug>`）。

### 变更概览

**影响范围**：`packages/core/`、`scripts/`、根文档、插件产物。

**主要操作**：

- **生成器**：`packages/core/src/git.ts` 的任务分支名模板由 `agent/${task.id}-${slug}` 改为 `tasklane/${task.id}-${slug}`；仅影响新生成分支，`task.branch` 已持久化的任务沿用原分支名。
- **验证脚本**：`scripts/git-verify.mjs` S8 错绑用例的预置分支同步为 `tasklane/` 前缀。
- **测试夹具**：`packages/core/test/git.test.ts` 三处 worktree 夹具分支名 `agent/TASK-x-task` → `tasklane/TASK-x-task`（夹具显式传 `branch`，语义不变）。
- **文档**：`README.md` Agent 闭环示例、`WORKFLOW.md` §6 的分支命名说明同步为 `tasklane/TASK-xxx-<标题短名>`。
- **产物重建**：`pnpm build:plugin` 刷新 `plugins/tasklane/server.mjs`、`kanban-widget.html`（内嵌 core 打包）。

### 设计动机

- 承接上一任务（`20261003-1812-purge-codex-kanban-naming.md`）的命名统一：分支名是用户在 Git 历史中可见的项目标识，统一到 tasklane 品牌。
- 兼容与回滚：分支名在指派时生成并随任务持久化，存量看板数据不受影响；如需回退，改回模板并对个别半绑定任务（无 `task.branch` 但已有旧前缀 worktree）重新指派即可，复用核验会给出明确报错。

### 验证结果

- 命令与结果（仓库根执行，全部通过）：
  - `pnpm build`：tsc -b 构建通过。
  - `pnpm test`：74/74 通过（含 git.test.ts 新前缀夹具）。
  - `pnpm verify:git`：GIT VERIFY PASSED（临时 Git 仓库，覆盖分支创建/复用/错绑降级）。
  - `pnpm build:plugin`、`pnpm verify:plugin`：插件重建并契约验证通过。
- 手工验证及环境：grep 复查活代码与根文档无 `agent/` 前缀残留。
- 未覆盖场景：未实测存量半绑定任务（无持久化分支 + 已有 `agent/` 前缀 worktree）的降级路径，按既有复用核验逻辑预期报 `GIT_ERROR` 并明确提示。

### 变更统计

> 仓库尚无提交，无 HEAD 基线；任务前后以工作区 vs 暂存区 diff 为口径（用户已在前一轮后重新暂存，本轮 diff 即本任务改动）。历史记录自身不计入。

- **变更文件数**：6
- **新增行数**：+41
- **删除行数**：-41

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/git.ts` | 1 | 1 |
| `packages/core/test/git.test.ts` | 3 | 3 |
| `scripts/git-verify.mjs` | 1 | 1 |
| `README.md` | 1 | 1 |
| `WORKFLOW.md` | 1 | 1 |
| `plugins/tasklane/server.mjs` | 34 | 34 |

（`plugins/tasklane/kanban-widget.html` 同步重建，行数未单列。）

### 修改文件

- `packages/core/src/git.ts`
- `packages/core/test/git.test.ts`
- `scripts/git-verify.mjs`
- `README.md`、`WORKFLOW.md`
- `plugins/tasklane/server.mjs`、`plugins/tasklane/kanban-widget.html`（构建产物重建）

### 后续事项

- 无。

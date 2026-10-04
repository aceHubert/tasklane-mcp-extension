# [2026-10-04 13:04 +0800] | 任务：纯中文标题的任务分支名去掉 -task 兜底后缀

## 执行上下文

- **Agent ID**：`zcode`
- **Base Model**：`GLM-5.3（account:zai-individual-coding-plan/GLM-5.3）`
- **Runtime**：`ZCode 桌面 CLI，macOS arm64`
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main（ unborn，尚无提交，HEAD 不可作差异基线）`
- **关联计划**：无（小范围行为修正，不涉及跨会话架构风险）

## 用户诉求

> 询问 `agent/TASK-101-task` 分支名为何出现两个 "task"；确认原因后明确要求变更：任务标题清洗为空时，分支名不再拼接 `-task` 兜底后缀。

## 变更概览

**影响范围**：`packages/core/`、`plugins/tasklane/`（构建产物重建）

**主要操作**：

- **slug 兜底移除**：`packages/core/src/git.ts` 的 `slug()` 不再返回 `'task'` 兜底值，纯中文/纯符号标题清洗后返回空串。
- **分支命名组合**：`ensureTaskContext` 中 `titleSlug` 为空时分支名只使用任务 ID（`tasklane/TASK-4`），非空时保持 `tasklane/TASK-4-<slug>`。
- **测试补充**：`packages/core/test/git.test.ts` 新增分支命名测试，覆盖 ASCII 标题拼 slug 与纯中文标题只留任务 ID 两条路径。
- **插件 bundle 重建**：`pnpm build:plugin` 重新生成 `plugins/tasklane/`。

## 设计动机

排查确认 `agent/TASK-101-task`（早期版本创建）由 `agent/${task.id}-${slug(task.title)}` 模板生成：任务 ID 固定为 `TASK-{seq}` 已含 "TASK"，而标题「测试」为纯中文，被 `[^a-z0-9]+` 清洗为空后落入 `|| 'task'` 兜底，导致前后重复。移除兜底后，空 slug 时直接省略后缀段，不再产生 `TASK-1-task` 冗余命名。

兼容性：已绑定任务的分支按 `task.branch` 原样复用并经 `assertWorktreeMatches` 核验，本变更只影响**新建**分支的命名，不迁移、不重命名既有分支（如 TASK-101 的 `agent/TASK-101-task` 保持原样）。回滚方式：还原 `git.ts` 中 `slug()` 与分支组合两处即恢复旧行为。

## 验证结果

- 命令与结果（均通过）：
  - `pnpm build`：tsc 构建成功。
  - `pnpm test`：136 个测试全部通过（含新增分支命名测试）。
  - `pnpm verify:git`：真实 Git 集成验证 PASSED（S1–S8，临时仓库环境）。
  - `pnpm build:plugin` + `pnpm verify:plugin`：bundle 重建成功，插件冒烟 ALL PASS。
- 手工验证及环境：无 UI 改动；Git 验证使用 `mkdtemp` 临时目录与临时 Git 仓库，未操作用户真实看板数据。
- 未覆盖场景：未在用户真实看板中触发新任务指派验证新命名；Codex 宿主侧原生执行链路未因本变更改动。

## 变更统计

> 仓库尚无提交（unborn main），`git diff HEAD` 不可用；且工作区含其他任务的未提交改动。源码统计采用**任务前快照对比**（依据编辑前确切内容重建）。`plugins/tasklane/` 为构建产物，其 diff 包含此前未提交源码改动被产物化的内容，不全部归属本任务。历史记录自身不计入。

- **统计口径**：任务前快照 `diff --no-index` 对比（`git.ts`、`git.test.ts`）；bundle 文件按 `git diff --numstat` 原样记录并注明归属 caveat。
- **变更文件数**：2（源码；另有 5 个 bundle 产物文件重建）
- **新增行数**：+23（git.ts +9、git.test.ts +14）
- **删除行数**：-8（git.ts）

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/git.ts` | +9 | -8 |
| `packages/core/test/git.test.ts` | +14 | -0 |
| `plugins/tasklane/server.mjs` | +51 | -51（产物重建，含其他任务未提交改动的产物化差异） |
| `plugins/tasklane/kanban-widget.html` | +13 | -11（同上） |
| `plugins/tasklane/plugin.json` | +4 | -4（同上） |
| `plugins/tasklane/.codex-plugin/plugin.json` | +4 | -4（同上） |
| `plugins/tasklane/skills/open-tasklane/SKILL.md` | +3 | -1（同上） |

## 修改文件

- `packages/core/src/git.ts`
- `packages/core/test/git.test.ts`
- `plugins/tasklane/`（`pnpm build:plugin` 重建产物）

## 后续事项

- 无。既有任务分支（如 `agent/TASK-101-task`）按兼容性策略保持原样，不做重命名迁移。

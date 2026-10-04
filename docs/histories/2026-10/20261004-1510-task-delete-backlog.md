# [2026-10-04 15:10 +0800] | 任务：backlog 任务删除（task_delete 工具 + 详情底部确认弹窗）

## 执行上下文

- **Agent ID**：`zcode`
- **Base Model**：`GLM-5.3（account:zai-individual-coding-plan/GLM-5.3）`
- **Runtime**：`ZCode 桌面 CLI，macOS arm64`
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main（unborn，尚无提交，HEAD 不可作差异基线）`
- **关联计划**：无（单会话功能补齐，不涉及跨会话架构风险）

## 用户诉求

> 任务创建后没有删除入口。要求：仅 backlog 状态可删除；UI 在 drawer 最下面增加删除，
> 使用 danger button，需要二次确认。

## 变更概览

**影响范围**：`packages/core/`、`mcp/`、`ui/`、`scripts/`、`plugins/tasklane/`（产物重建）、文档

**主要操作**：

- **core 守卫重写**：`BoardEngine.deleteTask` 从无守卫的同步方法改为任务锁内的异步方法，
  仅允许 backlog 且未进入执行链（无 `executionBinding`、执行态 idle/assigned）的任务删除；
  非 backlog / 已绑定 / 执行已推进分别抛带具体原因的 VALIDATION。
- **存储级联清理**：`JsonFileBoardStore.deleteTask` 删除任务时同步删除 `sessions[id]`，
  修复原先只删任务、时间线/会话记录变孤儿的问题。
- **MCP 工具**：注册 `task_delete`（`id, boardId?` → `{ id, deleted }`），Agent 与 UI 同契约。
- **UI**：TaskDetail 最底部（变更摘要之后）仅对 backlog 未归档任务渲染 danger「删除任务」；
  点击后弹出**页面内 ConfirmDialog**（复用 backdrop + modal 既有骨架的紧凑版）二次确认，
  取消/点击背景/Esc 均不产生写入，确认才调用 `task_delete`，成功后 toast 并关闭详情；
  失败经服务端守卫返回错误 toast。默认焦点在取消按钮，误按回车不会触发删除。
  （交互三易其稿：初版「再次点击确认」按钮态 → 按用户要求改原生 window.confirm →
  再改为页面内 React 组件——React 无内置 confirm，且原生 confirm 在宿主 iframe 未授予
  allow-modals 时会被静默拒绝，页面内组件顺带消除该风险。新增
  `ui/src/components/ConfirmDialog.tsx` 与配套样式，层级位于抽屉(30)/modal(35)之上、
  toast(60)之下。）
- **验证脚本**：smoke 增加 19 工具断言与删除全流程检查（非 backlog 拒绝 / 删除成功 /
  删除后 NOT_FOUND / 重复删除 NOT_FOUND）；verify-plugin 期望清单 20→21；
  build-plugin 头注释同步。
- **文档**：AGENTS 工具树与 README 工具契约表（18→19）新增条目。

## 设计动机

删除与归档互补：归档是完成后的留痕（保留内容、时间线与 Git 绑定），删除是「这条任务
根本不该存在」的清理口。两者边界必须清晰——只有从未进入执行链的任务（backlog 且无
绑定、无请求/回执）才允许硬删除，否则执行回执关联链会断；已完成任务一律走归档。

原 `deleteTask` 是无守卫、无锁、无级联清理的底层占位实现（见调研结论），本次按契约
补齐后暴露。级联清理放在存储事务内，保证 board.json 不留孤儿 sessions 记录；
任务锁沿用 move/assign 的 taskLocks → 文件锁顺序，与并发指派/回执串行化。

兼容性：`deleteTask` 此前无任何调用方（MCP/UI/脚本均未暴露），签名改异步无外部影响；
MCP 契约纯新增工具，v4 存储结构不变。回滚还原涉及文件即可，无数据迁移。

## 验证结果

- 命令与结果（均通过）：
  - `pnpm build`、`pnpm test`：144 项通过（新增 core 2 项：仅 backlog 可删/级联清理/
    BOARD_NOT_FOUND/TASK_NOT_FOUND，绑定与执行推进拒绝；mcp 契约 1 项）。
  - `pnpm smoke`：通过（新增删除全流程 4 项检查）。
  - `pnpm verify:twoproc`：通过（存储事务与并发改动按规范补跑）。
  - `pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui`：通过。
  - `node --test ui/test/*.mjs`：28 项通过、1 项失败——失败项为并行任务再次将
    APP_VERSION 升到 0.3.6 未同步断言（非本任务改动，未代改）。
  - `pnpm build:plugin` + `pnpm verify:plugin`：bundle 重建，21 工具断言通过。
- 浏览器验收（Chrome DevTools 驱动，127.0.0.1:7433 真实看板）：
  - 初版（再次点击确认，临时任务 TASK-104）：backlog 详情底部 danger 按钮 → 第一次点击变
    确认文案 → 第二次点击删除、toast、看板移除；doing/done/归档任务不渲染按钮。
  - **confirm 弹窗版复验（临时任务 TASK-107，独立标签页）**：点击「删除任务」弹出原生
    confirm，取消路径无写入、确认路径删除成功（自动化以接管 `window.confirm` 返回值
    方式驱动）。
  - **ConfirmDialog 页面内组件复验（临时任务 TASK-108/109，独立标签页）**：点击「删除
    任务」弹出页面内弹窗（遮罩 + 标题 + 文案 + [取消][删除任务(danger)] 按钮组）；
    取消路径：弹窗关闭、任务仍在看板；确认路径：toast「TASK-108 已删除」+ 服务端复核
    消失。截图：`docs/acceptance/20261004-task-delete-confirm-dialog.png`。
  - 临时验收任务已全部清理（TASK-104/107/108/109）。
- 环境与边界：自动化测试用临时目录/临时数据；浏览器验收使用真实看板的临时任务，
  验收后即删除，未触碰既有任务（期间并行会话与用户在同时操作看板，验证已改用
  独立标签页避免干扰用户操作）。
- 未覆盖场景：Codex 原生宿主（Desktop 面板）内的删除按钮与弹窗渲染待原生验收顺带取证
  （页面内组件已不依赖 iframe allow-modals，风险较原生 confirm 降低）。

## 变更统计

> unborn main 无提交基线，且工作区含多个并行任务的未提交改动：按本任务每处编辑的
> 精确前后内容反向重建对比；纯追加的测试/文案按行数计；bundle 产物、验收截图与
> 本记录不计。

- **统计口径**：编辑前后重建 diff；基线为本任务开始前的工作区状态。
- **变更文件数**：13（新增 `ConfirmDialog.tsx` 与样式；另 bundle 重建、验收截图）
- **新增行数**：+217（核心 +90、测试 +62、i18n +6、README +2、AGENTS +1、
  ConfirmDialog 组件 +44、样式 +13）
- **删除行数**：-10

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/engine.ts` | +24 | -7 |
| `packages/core/src/board-store.ts` | +2 | -0 |
| `packages/core/test/engine.test.ts` | +45 | -0（追加） |
| `mcp/src/handlers.ts` | +6 | -0 |
| `mcp/src/register.ts` | +16 | -0 |
| `mcp/test/tools.test.ts` | +17 | -0（追加） |
| `scripts/smoke.mjs` | +19 | -0 |
| `scripts/verify-plugin.mjs` | +1 | -1 |
| `scripts/build-plugin.mjs` | +1 | -1（注释计数） |
| `ui/src/components/TaskDetail.tsx` | +22 | -1 |
| `ui/src/i18n/messages.ts` | +6 | -0 |
| `AGENTS.md` / `README.md` | +3 | -1 |

## 修改文件

- `packages/core/src/engine.ts`、`packages/core/src/board-store.ts`
- `packages/core/test/engine.test.ts`
- `mcp/src/handlers.ts`、`mcp/src/register.ts`、`mcp/test/tools.test.ts`
- `ui/src/components/TaskDetail.tsx`、`ui/src/components/ConfirmDialog.tsx`（新增）、
  `ui/src/styles.css`、`ui/src/i18n/messages.ts`
- `scripts/smoke.mjs`、`scripts/verify-plugin.mjs`、`scripts/build-plugin.mjs`
- `AGENTS.md`、`README.md`
- `docs/acceptance/20261004-task-delete-confirm-dialog.png`、`docs/acceptance/20261004-task-delete-web.png`（web 验收截图）
- `plugins/tasklane/`（`pnpm build:plugin` 重建产物，含并行任务改动的产物化内容）

## 后续事项

- 无。UI 的 `sessionId` 类型收窄修复（`hasRealBinding` 谓词内联）属并行任务在途代码的
  编译问题，本次为保持构建绿色做了最小修复，已在其行文中注明。

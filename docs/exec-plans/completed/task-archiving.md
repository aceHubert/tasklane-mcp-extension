# 任务归档功能执行计划

- 状态：已完成（2026-10-03 实现并通过验证；Codex 原生宿主面板内人工验收未执行，见实际结果）
- 创建日期：2026-10-03
- 最后更新：2026-10-03
- 负责人：task-archiving 实施会话
- 关联历史记录：[2026-10/20261003-2157-task-archiving.md](../../histories/2026-10/20261003-2157-task-archiving.md)

## 目标

解决已完成任务长期堆积在 Done 列的问题。用户可以归档单个已完成任务，
或归档当前看板全部已完成任务；归档任务从日常看板和状态计数中移出，
仍可在归档区搜索、查看详情并恢复到 Done。任务内容、执行记录、分支和
worktree 绑定均保留。

## 范围

- 包含：归档数据模型、核心规则、存储事务、MCP 契约、窄栏与宽视图入口、
  已归档列表、恢复操作、自动化测试和文档更新。
- 不包含：自动定时归档、任务删除、Git 分支删除、worktree 清理、跨看板
  归档或迁移。归档不触发提交、合并或 Agent 启停。

## 背景

- 相关文档：[README.md](../../../README.md)、
  [WORKFLOW.md](../../../WORKFLOW.md)、
  [计划规范](../../PLANS_GUIDE.md)。
- 实施时任务状态为 `backlog / ready / doing / review / done`；
  `WorkItem` 没有归档字段，MCP 没有归档或恢复工具。
- 窄栏 `TaskList` 与宽视图 `BoardWide` 渲染搜索条件匹配的全部 Done 任务，
  没有归档入口或数量上限。
- 实施前 JSON 存储版本为 v2，存在跨进程文件锁与任务锁；单任务修改通过
  `mutateTask` 在锁内读取最新数据，尚无批量归档事务。
- UI 与 Agent 必须走同一套 MCP 业务入口，不直接改写存储文件。

主要实现位置：

- `packages/core/src/work-item.ts`、`board-store.ts`、`engine.ts`、`session.ts`。
- `mcp/src/register.ts`、`handlers.ts`。
- `ui/src/mcp/types.ts`、`state/BoardContext.tsx`、`state/useTaskActions.ts`。
- `ui/src/components/TaskCard.tsx`、`TaskDetail.tsx`、`TaskList.tsx`、
  `BoardWide.tsx`、`AppHeader.tsx`、`StatusTabs.tsx` 与样式。
- `packages/core/test/`、`mcp/test/`、`scripts/smoke.mjs`、
  `scripts/two-process-verify.mjs`。

## 拟定方案与业务规则（实施定稿）

### 归档模型

1. 独立可选字段 `archivedAt?: string`，不新增任务业务状态；时间戳由服务端
   生成。未设置即未归档。
2. 仅允许归档 `done` 任务（否则 `VALIDATION`）；归档后保持 `status: done`，
   恢复时移除 `archivedAt` 并更新 `updatedAt`。
3. 重复归档/恢复幂等：`changed=false`，不重复更新时间与时间线。
4. 归档任务可读；常规编辑、状态流转、指派与执行进度回调在核心层事务内
   拒绝（新错误码 `TASK_ARCHIVED`），提示先恢复；跨进程旧快照无法绕过。
5. 归档/恢复写入 `archived` / `restored` 时间线事件，与任务修改在同一
   持久化事务提交（存储新增 `mutateTaskWithEvent`）。

### MCP 契约（实施定稿）

| 工具 | 参数或调整 | 行为 |
| --- | --- | --- |
| `task_archive` | `id, boardId?` | 归档单个 Done 任务，返回 `{ task, changed }` |
| `task_restore` | `id, boardId?` | 恢复单个归档任务到 Done，返回 `{ task, changed }` |
| `task_archive_done` | `boardId` 必填 | 原子归档当前看板全部未归档 Done 任务，返回 `{ archivedCount, archivedIds }` |
| `task_list` | 新增 `archive: active \| archived \| all`，默认 `active` | 与现有筛选条件自由组合 |
| `task_get` | 无变化 | 可读取归档任务及时间线 |
| `board_list` | 新增 `archivedCount` | `counts` 与 `total` 仅统计未归档任务 |

- 存储层 `listTasks` 对 `archive` 不设默认（undefined = 不约束），供 ID
  分配、归属校验、计数等内部完整读取；业务默认 `active` 在引擎层注入。
- 单任务入口沿用归属校验（省略 `boardId` 用任务自身归属，错误归属
  `BOARD_MISMATCH`）；批量入口 `boardId` 必填，`BOARD_NOT_FOUND` 兜底。
- 批量归档经存储新增的 `mutateTasksWhere` 在文件锁内逐任务选取与修改，
  单次原子提交；并发回退到 review 的任务不被选中；零目标返回成功 0。

### 界面交互（实施定稿）

1. Done 卡片与详情提供「归档」；其他状态不展示。
2. 窄栏 Done 页与宽视图 Done 列头提供「归档全部已完成（N）」，无目标禁用；
   内联确认展示看板名与数量，提交期间禁用；成功按服务端返回数量反馈。
3. Header 独立「已归档」入口（`archivedCount` 徽标）打开归档视图：搜索
   （ID/标题）+ 归档时间倒序 + 恢复按钮；不新增第六个业务列。
4. 归档详情只读（标题/状态/优先级/描述/指派禁用），显示归档横幅与
   「恢复到 Done」唯一 CTA；恢复后 Done 与归档计数即时刷新。
5. 归档视图有专属搜索与代次守卫，切换看板自动关闭并清空；失败保留原
   列表并显示错误。UI 文案全部走 i18n 字典（与并行 i18n 任务协作）。

## 风险、兼容与回滚（实施结果）

- 存储升级为 v3：v1 链式经 v2 语义迁移，旧任务默认未归档；v2 仅校验与
  版本标记。迁移在文件锁内重读最新数据、备份 `.v1.bak` / `.v2.bak` 后
  原子写入；重复打开复用他人结果。`archivedAt` 非 NonEmptyString 时
  `STORE_ERROR` 明确报错且不落盘。（后续原生执行任务已将版本推进至 v4，
  归档字段语义不变。）
- 查询默认值与计数口径变化：同步更新 UI 类型、工具描述、README 与
  WORKFLOW；需要完整数据的调用方显式 `archive: all`。
- 锁顺序：单任务 `taskLocks`（进程内）→ 存储文件锁；批量只持文件锁且
  无异步间隙，与单任务顺序不构成环。守卫位于事务函数内，双进程并发与
  旧快照均不可绕过（twoproc 覆盖）。
- 归档只减少日常展示，不缩小 JSON 文件；分页仍不在本期范围。
- 回滚：功能纯增量，按文件回退即可；数据字段可选，旧版本程序读取 v3+
  文件会因版本未知明确报错（升级前停旧进程的要求见 README）。

## 里程碑与并行边界

1. **固定方案**：已完成（本节实施定稿）。
2. **核心与存储**：已完成。
3. **MCP 与 UI**：已完成（UI 与并行 i18n 任务共用 `ui/src/i18n/` 字典，
  归档文案以追加键方式合入，无冲突）。
4. **整合交付**：自动化验证、插件重建与浏览器验收已完成；Codex 原生
  面板人工验收未执行（见下）。

## 验证方式与验收标准

自动化验证（全部通过，2026-10-03）：

- `pnpm build`、`pnpm test`（118 通过 / 0 失败，含归档专项 17 例）、
  `pnpm smoke`（含归档链路 18 项断言）、`pnpm verify:twoproc`
  （含归档并发 P4 五项）。
- `pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui`、
  `pnpm build:plugin`、`pnpm verify:plugin`（17 工具契约 + 归档工具）。
- 后台测试均在 60 秒硬超时内完成；集成验证使用临时数据目录与临时 Git
  仓库，未触碰真实看板。

必须覆盖的验收条件：

- [x] 未归档 Done 可单条归档；其他状态拒绝；重复归档/恢复无重复副作用。
- [x] 默认列表和状态计数排除归档任务；归档列表、完整查询和详情可读。
- [x] 恢复后回到 Done，任务 ID、内容、执行信息、分支和 worktree 绑定保留。
- [x] 批量归档只作用于指定看板；覆盖空集合、重复请求、错误归属与并发回退。
- [x] 归档任务的常规修改被核心层拒绝，不能通过 MCP 或旧 UI 绕过。
- [x] 并发归档与编辑不丢字段；任务与事件原子提交，失败无部分批量写入。
- [x] v1/v2 旧数据迁移、重复启动及损坏字段处理符合兼容策略（单测覆盖）。
- [x] 窄栏与宽视图均能归档、搜索、查看、恢复，按钮数量与后端结果一致
  （独立浏览器验收）。
- [x] 看板切换、断连、请求失败、空归档区及搜索无结果都有可理解的反馈
  （独立浏览器验收；断连由既有横幅机制覆盖）。
- [x] 浏览器独立模式验收已记录（窄栏 420px + 宽视图 1280px，中英双语）；
  Codex 原生宿主：`verify:plugin` 工具面通过，面板内人工交互验收未执行
  （本会话无 Codex 宿主），沿用原生执行计划的原生验收债。

浏览器独立模式验收记录（bridge 7461 + 临时数据目录，Chrome/内置浏览器）：

- 窄栏：Done 页批量归档条（含数量与禁用态）、单卡归档、归档徽标计数、
  归档视图（搜索空态/恢复/详情只读/恢复后解锁）、toast 反馈全部符合预期；
  修复了一处验收中发现的问题（human 指派的 done 卡片缺少归档入口）。
- 宽视图：Done 列头批量归档、归档视图恢复后 Done 列计数与卡片即时刷新。
- 中英文切换下归档文案均正确（en/zh 字典全覆盖）。

## 进度记录

- [x] 确认当前缺少归档能力，记录目标、约束及拟定方案。
- [x] 编写待执行计划。
- [x] 固定模型、MCP 契约、存储版本、迁移和锁顺序。
- [x] 完成核心、存储、迁移与并发测试。
- [x] 完成 MCP 工具、UI 入口与归档列表。
- [x] 完成整合验证并记录实际结果与未覆盖场景。
- [x] 文档更新（README 工具表、WORKFLOW §6、插件说明）；无新增技术债
  （原生面板验收债沿用既有登记）。
- [x] 补齐历史记录，移至 `completed/` 并更新链接。

## 决策记录

- 2026-10-03：归档使用独立字段，保留五个业务状态与 Done 的完成语义。
- 2026-10-03：本期只归档已完成任务，支持单条与当前看板批量操作，支持恢复。
- 2026-10-03：归档保留任务和 Git 工作区；不把归档与删除、清理绑定。
- 2026-10-03（实施）：存储升级 v3（v1 链式迁移、备份 `.v1.bak`/`.v2.bak`、
  损坏 `archivedAt` 报 `STORE_ERROR`）。
- 2026-10-03（实施）：归档守卫放事务函数内基于磁盘最新状态执行，新错误码
  `TASK_ARCHIVED`；非 done 归档为 `VALIDATION`。
- 2026-10-03（实施）：批量归档经 `mutateTasksWhere` 单事务原子提交，目标
  选取在锁内完成；单任务归档/恢复复用 `lockTask` → `mutateTaskWithEvent`
  （任务修改与事件原子提交）。
- 2026-10-03（实施）：存储层 `listTasks` 不设归档默认（内部完整读取），
  业务默认 `active` 由引擎层注入，避免归档任务从 ID 分配等内部处理消失。
- 2026-10-03（实施）：UI 归档文案以 i18n 键追加进并行任务的字典，
  `board_list.archivedCount` 驱动入口徽标；批量确认用内联 alertdialog
  而非原生 confirm（宿主 iframe 可能禁弹窗）。

## 阻塞点与下一步

- 当前阻塞：无。
- 后续可选项：Codex 原生面板内的归档交互人工验收（随原生执行计划的原生
  验收债一并执行）；归档列表分页与存储体积优化（本期明确不做）。

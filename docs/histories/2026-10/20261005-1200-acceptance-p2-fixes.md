## [2026-10-05 12:00 +0800] | 任务：验收 P2 缺陷修复（截止时间时区/日历校验、回执卡片装饰隔离）

### 执行上下文

- **Agent ID**：`zcode`
- **Base Model**：`GLM-5.3-Flash（account:zai-individual-coding-plan/GLM-5.3-Flash）`
- **Runtime**：`ZCode CLI（darwin 25.6.0 arm64，Node.js 20+，pnpm workspace）`
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main（未提交，工作区改动）`
- **关联计划**：`docs/exec-plans/completed/task-deadline-field-and-sorting.md`（deadline 主体）；P2-2 属并行会话的回执卡片改动（`docs/exec-plans/completed/native-execution-report-card.md`），本条为验收缺陷修复，不改变该计划状态

### 用户诉求

> 验收完成，两项暂未通过，发现 3 个 P2 问题：
> - 截止时间跨时区保存会偏移，实测晚了 8 小时。
> - 2026-02-30 被接受并自动改成 2026-03-02。
> - 卡片组装异常时，回执返回失败，但任务已写入 running / doing

依据验收记录 `docs/acceptance/20261005-deadline-and-report-card.md` 定位并修复。

### 变更概览

**影响范围**：`packages/core/`、`mcp/`、`ui/`、`README.md`、`plugins/tasklane/`（产物重建）。

**主要操作**：

- **P2-1 时区偏移**：`packages/core/src/work-item.ts` 新增严格解析 `parseDeadline`——无时区标记的输入一律按 UTC 解析（`Date.UTC` 组装，不经 `new Date` 的进程时区路径）；UI 侧新增 `localInputToIso`（`ui/src/mcp/types.ts`），`NewTaskForm` 提交与 `TaskDetail.blurDeadline` 保存前在浏览器内把 `datetime-local` 本地值换算为带 `Z` 的 UTC ISO，空值保持 `undefined` / `null` 语义。服务端时区与浏览器不同时不再偏移。
- **P2-3 无效日历日期**：`parseDeadline` 严格校验年月日与时分秒分量（月 1-12、日按当月天数含闰年、时 ≤23、分/秒 ≤59、偏移 ≤±23:59），拒绝 `2026-02-30`、`2026-02-29`（非闰年）、`T24:00` 等，不做 `new Date` 式静默滚动；`mcp/src/register.ts` 的 `deadlineSchema` 由 `Date.parse` 可解析性改为复用 `parseDeadline` 严格校验，schema 层即拒绝；工具 description 说明 UTC 语义。
- **P2-2 回执装饰异常**：`mcp/src/register.ts` 的 `task_execution_report` apps 装饰路径将 `widgetDataFor` 包入 try/catch——回执已成功持久化后装饰抛错时降级返回原成功结果（无卡片字段、无 `_meta`），诊断写 stderr，不再把成功回执变成 `isError`。
- **测试**：core 新增「拒绝不存在日历日期与越界分量；闰年与显式偏移合法」用例（含 2028 闰年 02-29、`+08:00` 偏移换算、`T24:00` 拒绝）；既有 deadline 用例期望值改为确定性 UTC 断言；mcp schema 用例新增 `2026-02-30T18:00:00Z` 拒绝；`apps-report.test.ts` 新增「组装器抛异常不把已持久化的成功回执变成错误」用例（含幂等重放与独立只读 store 核验落盘 running/doing）。
- **产物**：`pnpm build:plugin` 重建 `plugins/tasklane/`（register.ts 改动同步进 bundle），`pnpm verify:plugin` 通过。

### 设计动机

时区问题的根因是无时区标记字符串经 `new Date()` 按服务端进程时区解释（验收场景：浏览器 Asia/Shanghai、MCP 进程 UTC，晚 8 小时）。修复采取「谁有本地语义谁负责带时区」：浏览器提交前转 UTC ISO；服务端对无法带时区的直接调用方（Agent）定义确定性行为——无标记按 UTC，写入契约文档。日历校验沿用同一严格解析器，schema 与 engine 单一实现避免两端口径漂移。装饰隔离遵循「卡片故障不阻塞回执」的既有要求：装饰是展示增强，失败降级为纯结果并把诊断写 stderr（stdout 仅 JSON-RPC 的仓库约定）。

### 验证结果

- 命令与结果：
  - `pnpm build` 通过；`pnpm test` 299/299 通过（含新增用例）。
  - 多时区回归：`TZ=UTC / Asia/Shanghai / America/New_York` 下分别运行 core engine 测试（31/31 通过）与 `parseDeadline` 抽查，三时区结果逐字节一致（无标记 → `18:00:00.000Z`、`+08:00` → `10:00:00.000Z`、`02-30` → null）。
  - `pnpm smoke` SMOKE PASSED；`pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui` 通过。
  - `pnpm build:plugin` + `pnpm verify:plugin` ALL PASS。
  - `node --test ui/test/*.test.mjs` 49/53：4 项失败与验收记录完全一致（`native.recovery.action` 既有失败，非本轮引入）。
- 手工验证及环境：独立 Chrome 复现验收场景——bridge/MCP 以 `TZ=UTC` 启动（`TASKLANE_HOME=/tmp/tasklane-p2fix-verify`，端口 7499），浏览器 `Asia/Shanghai`。新建表单填 `2026-10-10T18:01`：磁盘存 `2026-10-10T10:01:00.000Z`（修复前为 `18:01Z`）；详情回显 `2026-10-10T18:01`、卡片 chip「10-10 18:01」，无偏移。详情编辑为 `2026-11-01T09:30` 后落盘 `2026-11-01T01:30:00.000Z`，两个提交点均正确。未触碰真实看板，验证后已清理。
- 未覆盖场景：真实 Codex 宿主内的出卡与展开聚焦（属回执卡片计划复验条件，需真实宿主取证）；归档详情的 deadline 输入禁用态浏览器取证。

### 变更统计

> 统计口径：工作区包含两个并行会话的未提交改动（本轮修复 + 回执卡片功能），无法用单一 `git diff` 基线分离。下表为本轮修复相对上一条历史记录（`20261005-0012`）的增量，独占文件按两次 numstat 差值计算，`register.ts` 与 `apps-report.test.ts` 按本轮实际编辑手工核对，均排除并行会话部分。

- **变更文件数**：9（另 `plugins/tasklane/` 产物随 build:plugin 重建）
- **新增行数**：约 +146
- **删除行数**：约 -10

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/work-item.ts` | 47 | 0 |
| `packages/core/test/engine.test.ts` | 24 | 0 |
| `mcp/src/register.ts` | 18 | 6 |
| `mcp/test/tools.test.ts` | 9 | 0 |
| `mcp/test/apps-report.test.ts` | 34 | 0 |
| `ui/src/mcp/types.ts` | 10 | 0 |
| `ui/src/components/NewTaskForm.tsx` | 1 | 1 |
| `ui/src/components/TaskDetail.tsx` | 1 | 0 |
| `README.md` | 2 | 2 |

### 修改文件

- `packages/core/src/work-item.ts`
- `packages/core/test/engine.test.ts`
- `mcp/src/register.ts`
- `mcp/test/tools.test.ts`
- `mcp/test/apps-report.test.ts`
- `ui/src/mcp/types.ts`
- `ui/src/components/NewTaskForm.tsx`
- `ui/src/components/TaskDetail.tsx`
- `README.md`
- `plugins/tasklane/`（构建产物，`pnpm build:plugin` 生成）

### 后续事项

- 验收复验条件 1、2 已满足（时间提交修复 + 严格日历校验 + 回归测试；装饰异常隔离 + 真实 MCP 失败回退用例）。
- 复验条件 3（4 项 `native.recovery.action` UI 断言差异）为既有失败，维持登记，未在本轮处理。
- 复验条件 4（真实 Codex 宿主出卡/聚焦/隔离取证）需真实宿主环境，属回执卡片计划收尾，未在本轮覆盖。

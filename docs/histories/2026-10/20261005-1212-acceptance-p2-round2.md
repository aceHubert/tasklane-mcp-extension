## [2026-10-05 12:12 +0800] | 任务：复验缺陷修复（装饰序列化隔离、短年份重映射）

### 执行上下文

- **Agent ID**：`zcode`
- **Base Model**：`GLM-5.3-Flash（account:zai-individual-coding-plan/GLM-5.3-Flash）`
- **Runtime**：`ZCode CLI（darwin 25.6.0 arm64，Node.js 20+，pnpm workspace）`
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main（未提交，工作区改动）`
- **关联计划**：`docs/exec-plans/completed/task-deadline-field-and-sorting.md`（P3）；P2 属回执卡片域（`docs/exec-plans/completed/native-execution-report-card.md`），本条为复验缺陷修复

### 用户诉求

> 复验确认：时区偏移、非法日期、组装器直接抛错的场景已修复。核心/MCP 299 项全通过。
> 仍未完整通过：P2——字段合并和 JSON 序列化仍在异常保护外，注入 `BigInt` 后回执返回失败但状态已持久化；P3——`0000–0099` 年会被错误映射到 `1900–1999`。4 项 UI 测试仍失败，真实宿主出卡与聚焦仍待取证。

依据复验记录 `docs/acceptance/20261005-deadline-and-report-card.md`（已更新）修复 P2、P3；4 项 UI 断言与真实宿主取证不在本轮范围（分属既有失败与回执卡片计划收尾）。

### 变更概览

**影响范围**：`packages/core/`、`mcp/`、`plugins/tasklane/`（产物重建）。

**主要操作**：

- **P2（二轮）装饰隔离扩全链路**：`mcp/src/register.ts` 的 `task_execution_report` 装饰路径把回调（`widgetDataFor`）、字段合并（对象展开）、`JSON.stringify` 序列化与结果组装全部纳入同一个 try/catch——任一环节抛错（含组装器注入 BigInt/循环引用等不可序列化数据）都降级返回原成功纯结果，诊断写 stderr。此前 try 只包回调调用，合并与序列化在保护外。
- **P3 短年份重映射**：`packages/core/src/work-item.ts` 的 `parseDeadline` 改用固定闰年 2000 组装再 `setUTCFullYear` 写回字面年份。根因：`Date.UTC(year, …)` 对 0-99 年施加两位年规则（`0099 → 1999`），且重映射基准 1900 非闰年使 `0000-02-29`（年 0 按闰年规则合法）滚到 `1900-03-01`。2000 是闰年，任何通过校验的月/日组合可先安全表示；`setUTCFullYear` 无两位年重映射。年份支持 0000-9999。
- **测试**：`mcp/test/apps-report.test.ts` 新增「组装器返回不可序列化数据（BigInt）时同样降级为纯结果」（复现复验注入场景，核验落盘 running/doing）；既有降级用例按复验建议补强幂等断言——重放同一 reportId 前后 `getSession` 时间线事件数不变。`packages/core/test/engine.test.ts` 新增短年份用例（`0099-02-28`、`0000-02-29` 字面保留）。

### 设计动机

装饰是展示增强，「卡片故障不阻塞回执」要求覆盖装饰到返回的完整路径：只保护回调调用时，合并或序列化抛错仍会把已持久化的成功回执变成 `isError`，调用方会误判回执失败。整个装饰块（唯一目的为增强展示）进保护区、失败回退纯结果，语义最简单且不会吞掉回执本身的错误（`reportHandler` 的失败在装饰前已短路返回）。短年份修复选择「固定闰年基准 + setUTCFullYear」而非限制年份范围：ISO 8601 允许 0000-9999，规范化输出保持 4 位年份补零，字典序排序语义不变。

### 验证结果

- 命令与结果：
  - `pnpm build` 通过；`pnpm test` 300/300 通过（新增 BigInt 注入与短年份用例）。
  - 多时区回归：`TZ=UTC / Asia/Shanghai / America/New_York` 下 core engine 测试 31/31 通过；`parseDeadline` 抽查三时区结果一致——`0099-02-28` → `0099-02-28T00:00:00.000Z`（修复前 `1999-…`）、`0000-02-29` → `0000-02-29T00:00:00.000Z`（修复前 `1900-03-01`）、`0050-01-01T00:00:00+02:00` → `0049-12-31T22:00:00.000Z`（偏移跨年边界且年 49 未重映射）。
  - `pnpm smoke` SMOKE PASSED；`pnpm build:plugin` + `pnpm verify:plugin` ALL PASS。
- 手工验证及环境：本轮改动为纯服务端逻辑，复验注入场景（BigInt 装饰数据）已由新测试在真实核心 + 内存 MCP 全链路覆盖，未重复浏览器取证。
- 未覆盖场景：真实 Codex 宿主出卡/聚焦/隔离取证（回执卡片计划复验条件 4）；4 项 `native.recovery.action` UI 断言差异（既有失败，未处理）。

### 变更统计

> 统计口径：相对上一条历史记录（`20261005-1200`）的增量；独占文件按两次 numstat 差值，`register.ts` 为块重写（numstat 相对 HEAD 不变，按实际编辑手工核对），`apps-report.test.ts` 为未跟踪新文件的行数差。

- **变更文件数**：4（另 `plugins/tasklane/` 产物随 build:plugin 重建）
- **新增行数**：约 +44
- **删除行数**：约 -12

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/work-item.ts` | 6 | 0 |
| `packages/core/test/engine.test.ts` | 6 | 0 |
| `mcp/src/register.ts` | 12 | 10 |
| `mcp/test/apps-report.test.ts` | 20 | 2 |

### 修改文件

- `packages/core/src/work-item.ts`
- `packages/core/test/engine.test.ts`
- `mcp/src/register.ts`
- `mcp/test/apps-report.test.ts`
- `plugins/tasklane/`（构建产物，`pnpm build:plugin` 生成）

### 后续事项

- 复验新增 P2、P3 已修复并附回归用例，可复验。
- 4 项 `native.recovery.action` UI 断言差异维持登记（既有失败，需产品决策恢复控件行为或更新断言）。
- 真实 Codex 宿主出卡、展开聚焦与看板隔离取证仍待具备宿主环境时完成（回执卡片计划收尾）。

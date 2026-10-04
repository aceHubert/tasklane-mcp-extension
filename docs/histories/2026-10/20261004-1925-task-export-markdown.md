## [2026-10-04 19:25 +0800] | 任务：新增按时间区间的 Markdown 任务导出

### 执行上下文

- **Agent ID**：ZCode 主代理（无子代理拆分）
- **Base Model**：GLM（ZCode 会话模型，版本未知）
- **Runtime**：ZCode CLI，本地 macOS 工作区；浏览器验收使用内置浏览器（IAB）
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main（尚无有效 HEAD）
- **关联计划**：[task-export-markdown](../../exec-plans/completed/task-export-markdown.md)

### 用户诉求

> 设计一个导出的功能，生成 md 文档，条件可以设置开始时间和结束时间，默认是从今天往前面推一个月。
> 后续澄清：把导出放在设置 menu 下；不需要展示生成内容/触发下载，直接显示文件路径并加一个复制路径按钮；
> 文件名加一个时间戳，不然会产生冲突的可能。

### 变更概览

**影响范围**：`packages/core/`、`mcp/`、`ui/`、`scripts/`、`docs/`。

- 新增只读 MCP 工具 `task_export`：按时间区间把看板任务渲染为 Markdown 报告并原子落盘，
  返回 `path/bytes/range/scope/stats/markdown`；不改任务、存储版本与执行链。
- core 新增导出模块：区间解析（缺省今天往前一个自然月、月末回退、非法日期拒绝）、
  命中口径（创建/更新/归档任一落在闭区间）、scope 过滤（默认含归档）、中英双语渲染、
  默认导出目录（`$TASKLANE_HOME/exports/`）与带时间戳文件名、临时文件 + rename 原子写入。
- UI：设置菜单新增「导出报告」项（宽窄视图一致），导出对话框提供起止日期
  （默认今天/一个月前，含本月/上月快捷项）、范围选择；生成后仅显示文件路径与
  「复制路径」，剪贴板被宿主拒绝时回退为选中路径文本；中英文案随界面语言切换。
- 冒烟脚本工具计数 21→22 并新增导出链路检查；README 工具契约表、AGENTS.md 工具清单同步。

### 设计动机

报告是一次性产物，不进入任务生命周期，因此做成只读工具而非任务字段写入；UI 与 Agent
共用同一 MCP 契约，UI 只消费返回的 `path`，完整 `markdown` 留给 Agent。命中口径取三类
时间任一命中，避免只按创建时间漏掉区间内推进的老任务；`scope` 默认含归档以覆盖月报里的
已完成项。文件名携带生成时间戳（本地 yyyyMMdd-HHmmss），同区间重复/并发导出各得一份文件，不互相覆盖；
同一秒内的极端冲突仍按覆盖处理。落盘默认进入数据目录 `exports/`，不污染用户仓库，
Agent 需要仓库内文件时显式传 `path`。存储保持 v4，无迁移与回滚需求；移除工具注册与
UI 入口即可回滚，已导出文件由用户自行处置。

### 验证结果

- `pnpm build`、`pnpm test`：271 项全部通过（新增 core 导出测试 9 项、MCP 契约测试 2 项）。
- `pnpm smoke`：全部通过（业务工具 14→15、总数 21→22，含默认区间/落盘/只读/错误通道检查）。
- UI：`pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui` 通过；bridge + 内置浏览器验收
  （截图 `docs/acceptance/20261004-task-export-dialog.png`）：设置菜单入口、默认日期、
  生成后仅显示路径与复制按钮、start>end 禁止提交、scope=archived 仅含归档任务、
  中英文案切换、宽视图菜单仅含导出项、带时间戳文件名两次导出并存。
- 环境差异如实记录：内置浏览器的剪贴板写入被拒，路径文本自动选中并由提示引导手动复制，
  属设计内降级；IAB 对该头部按钮的高层 click 超时，验收改用页面内原生 click，非产品缺陷。
- 过程修正：初版测试的 TASKLANE_HOME 恢复时机写在异步完成前，一次运行把测试报告写入了
  真实 `~/.tasklane/exports/`；已删除该测试产物（exports 目录由该次运行新建，未触碰
  board.json），并改为 fixture 内固定临时目录 + 文件级兜底，杜绝再次外写。
- 未覆盖场景：Codex 原生面板内的实际交互验收（等待用户在宿主环境操作）。

### 变更统计

> **统计口径**：仓库无有效 HEAD 且工作区混有其他任务的未提交改动；新增文件按整文件计
> （`wc -l`，未跟踪），修改文件的 `git diff --numstat` 含任务开始前已有的未提交改动，
> 仅作上界参考；历史记录自身不计入。

- **新增文件数**：6（含 1 个二进制截图）
- **修改文件数**：12（numstat 为含既有未提交改动的上界）

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/export.ts`（新增） | 535 | — |
| `packages/core/test/export.test.ts`（新增） | 298 | — |
| `mcp/test/task-export.test.ts`（新增） | 75 | — |
| `ui/src/components/ExportDialog.tsx`（新增） | 238 | — |
| `docs/exec-plans/active/task-export-markdown.md`（新增） | 147 | — |
| `docs/acceptance/20261004-task-export-dialog.png`（新增） | bin | — |
| `packages/core/src/engine.ts` | 上界 213 | 上界 138 |
| `packages/core/src/index.ts` | +2 | 0 |
| `mcp/src/handlers.ts` | 上界 86 | 上界 2 |
| `mcp/src/register.ts` | 上界 324 | 上界 11 |
| `scripts/smoke.mjs` | 上界 252 | 上界 14 |
| `ui/src/components/HeaderSettings.tsx`（未跟踪） | 整文件 | — |
| `ui/src/components/AppHeader.tsx` | 上界 69 | 上界 31 |
| `ui/src/components/icons.tsx` | 上界 46 | 上界 3 |
| `ui/src/i18n/messages.ts`（未跟踪） | 整文件 | — |
| `ui/src/styles.css` | 上界 204 | 上界 15 |
| `README.md` / `AGENTS.md` | 上界 | 上界 |

### 修改文件

- `packages/core/src/export.ts`、`packages/core/src/engine.ts`、`packages/core/src/index.ts`
- `packages/core/test/export.test.ts`、`mcp/test/task-export.test.ts`
- `mcp/src/handlers.ts`、`mcp/src/register.ts`、`scripts/smoke.mjs`
- `ui/src/components/ExportDialog.tsx`、`ui/src/components/HeaderSettings.tsx`、
  `ui/src/components/AppHeader.tsx`、`ui/src/components/icons.tsx`、
  `ui/src/i18n/messages.ts`、`ui/src/styles.css`
- `README.md`、`AGENTS.md`、`docs/exec-plans/active/task-export-markdown.md`、
  `docs/acceptance/20261004-task-export-dialog.png`

### 后续事项

- Codex 原生面板内的导出交互验收未完成，待用户在宿主环境操作后补充取证
  （计划保持进行中，不以模拟界面代替宿主结果）。

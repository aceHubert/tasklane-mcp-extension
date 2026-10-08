## [2026-10-08 14:00 +0800] | 任务：验收结论默认两行并支持展开折叠

### 执行上下文

- **Agent ID**：`codex`
- **Base Model**：未知
- **Runtime**：Codex Desktop
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main`
- **关联计划**：无

### 用户诉求

> 1. 把「执行工作方式」修改为「执行（EXECUTION）」，修改完成没有；
> 2. 把验收轮次的回执修改为默认显示 2 行，后面显示展开/折叠。

### 变更概览

**影响范围**：`ui/`、`plugins/tasklane/`、`docs/histories/`。

**主要操作**：

- **确认第一项已完成**：执行区块标题已使用 `native.executionSection`，中文文案为「执行（EXECUTION）」；「执行工作方式」仅保留为工作方式字段标签，本次未改动。
- **验收结论折叠**：验收轮次结论改为原生 `details/summary`，默认显示两行，长文本可展开并再次折叠。
- **文案与样式**：新增中英文「展开 / 折叠」文案，补充两行截断、展开态和折叠态样式。
- **回归测试**：`ui/test/review-controls.test.mjs` 增加折叠结构、展开/折叠文案及两行样式断言。
- **插件产物同步**：重建 `plugins/tasklane/kanban-widget.html`，使实际安装包包含本次 UI 改动。

### 设计动机

使用原生 `details/summary` 承载展开状态，避免引入额外状态管理或脚本；默认两行限制只在折叠态生效，展开后恢复完整文本并保留换行。这样既减少长结论对详情页的挤压，也不改变轮次结论的持久化结构。

### 验证结果

- `timeout 60s pnpm --filter @tasklane/ui typecheck`：通过。
- `timeout 60s node --test ui/test/review-controls.test.mjs ui/test/review-linked-continuation.test.mjs`：23/23 通过。
- `timeout 60s node --test ui/test/*.test.mjs`：93/93 通过。
- `timeout 60s pnpm --filter @tasklane/ui build`：通过。
- `timeout 120s pnpm build:plugin`：通过，已更新单文件 widget。
- `timeout 120s pnpm verify:plugin`：ALL PASS。
- 未覆盖场景：未在真实 Codex 原生宿主中人工点击验收轮次的展开/折叠，需用户侧做最终视觉验收。

### 变更统计

> 工作区存在大量任务前已有改动；以下仅统计本次新增或追加的内容，无法用 `git diff HEAD` 单独区分同一文件中的既有改动，故按本次补丁范围人工汇总。历史记录自身不计入统计。

- **统计口径**：本次补丁对验收结论折叠的净新增内容，不含任务前已有改动；`plugins/tasklane/kanban-widget.html` 为构建生成产物的同步更新。
- **变更文件数**：5
- **新增行数**：约 +52
- **删除行数**：约 -2

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/components/TaskDetail.tsx` | 12 | 2 |
| `ui/src/styles.css` | 12 | 0 |
| `ui/src/i18n/nativeMessages.ts` | 4 | 0 |
| `ui/test/review-controls.test.mjs` | 6 | 0 |
| `plugins/tasklane/kanban-widget.html` | 构建产物 | 构建产物 |

### 修改文件

- `ui/src/components/TaskDetail.tsx`
- `ui/src/styles.css`
- `ui/src/i18n/nativeMessages.ts`
- `ui/test/review-controls.test.mjs`
- `plugins/tasklane/kanban-widget.html`

### 后续事项

- 真实原生宿主中的展开/折叠视觉与点击行为待人工验收。

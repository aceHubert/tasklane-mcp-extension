## [2026-10-06 18:23 +0800] | 任务：补齐普通继续执行提示词编辑

### 执行上下文

- **Agent ID**：codex
- **Base Model**：未知（未核验运行模型标识）
- **Runtime**：Codex Desktop，本地工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main
- **关联计划**：`docs/exec-plans/completed/review-binding-and-external-execution.md`

### 用户诉求

> 在 Codex 中继续执行没有展示可修改提示词，需求中已经要求支持。

### 变更概览

**影响范围**：UI 详情、执行动作、国际化文案与回归测试。

- 普通续接按钮上方展示预填的提示词编辑框，支持多行和最多 20,000 字符。
- 草稿按任务隔离，切换任务重置，同任务刷新不覆盖用户编辑。
- continueExecution 接受 message，沿用现有 MCP 请求保存和原生消息投递链路。
- 没有真实目标或宿主未连接时不展示编辑框；不可执行时禁用编辑。
- 保留 Review 修改和复查的独立提示词编辑流程。

### 设计动机

遗漏位于普通继续入口：Review 已有编辑器，普通继续却未将用户正文传入
execute。复用现有 message 契约，仅调整 UI 和动作参数；内部身份、工作区、
模型复用及回执协议继续由系统生成。

### 验证结果

- `timeout 60s node --test ui/test/task-detail-controls.test.mjs ui/test/native-execution.test.mjs ui/test/review-controls.test.mjs`：64 项通过。
- `pnpm --filter @tasklane/ui typecheck`：通过。
- `pnpm build:ui`：通过。
- 回归覆盖窄详情/宽抽屉的编辑器显示、无绑定/断连隐藏及多行全文保存投递。
- 内置 Chrome 两次返回 `Unable to load browser request-header policy`，
  未能打开临时验收页面；浏览器交互、实际原生面板及草稿切换交互未验收。
- 构建期间检测到其他任务同时更新非 Git 说明和 Review 提示词测试，
  保留这些修改，并对最新工作区重新运行相关验证。

### 变更统计

- **统计口径**：与修改前临时快照使用 `git diff --no-index --shortstat`
  和 `--numstat` 比较，仅计本任务差异块，扣除期间其他任务修改；
  不包含历史记录自身。退出码 1 表示存在差异。
- **变更文件数**：5
- **新增行数**：+30
- **删除行数**：-8

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/components/TaskDetail.tsx` | 16 | 1 |
| `ui/src/state/useTaskActions.ts` | 1 | 1 |
| `ui/src/i18n/nativeMessages.ts` | 4 | 0 |
| `ui/test/task-detail-controls.test.mjs` | 2 | 1 |
| `ui/test/native-execution.test.mjs` | 7 | 5 |

### 修改文件

- `ui/src/components/TaskDetail.tsx`
- `ui/src/state/useTaskActions.ts`
- `ui/src/i18n/nativeMessages.ts`
- `ui/test/task-detail-controls.test.mjs`
- `ui/test/native-execution.test.mjs`

### 后续事项

- 内置浏览器恢复后，补验实际输入、切换任务草稿隔离及 Codex 原生面板展示。
- 本次未提交 Git。

## [2026-10-08 00:55 +0800] | 任务：看板卡片增加执行/验收状态标签（0.3.20）

### 执行上下文

- **Agent ID**：zcode
- **Base Model**：account:zai-individual-coding-plan/GLM-5.3
- **Runtime**：ZCode 桌面会话（本仓库工作区）
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main（工作区含未提交改动，未执行 git add/commit）
- **关联计划**：无独立计划（小型 UI 跟进，验收记录见 docs/acceptance/20261008-card-state-tags.md）

### 用户诉求

> 看板中需要把验收的状态 tag 也体现出来，例如：执行·已完成，验收·阻塞

### 变更概览

**影响范围**：`ui/src/`、版本号四处 + widget URI、验收/测试断言。

**主要操作**：

- `TaskCard.tsx`：执行态 chip 加前缀；新增 `task.reviewExecution.state`（非 idle）驱动的验收态
  chip，配色与状态文案复用既有映射。
- i18n：`card.execTag`/`card.reviewTag` 中英键；UI 测试版本断言、verify-plugin/apps-report
  的 URI 与版本升至 0.3.20 / v0320。
- 交付需要宿主重装：版本 0.3.19 → 0.3.20（插件缓存按版本目录隔离）。

### 设计动机

执行（task.execution）与验收（task.reviewExecution）是两条独立回执链，卡片此前只显示执行侧；
双 tag 并列让 review 列任务的验收进度（含阻塞）一眼可见。idle 为验收链初始值不展示，避免
非验收任务出现噪音。

### 验证结果

- typecheck / build:ui / UI 测试 89/89 / build:plugin + verify-plugin ALL PASS。
- 浏览器独立验收（bridge 7498 + 临时展示夹具）：中英文标签与截图见验收记录
  docs/acceptance/20261008-card-state-tags.md。
- 未执行：Codex 原生宿主内视觉验收（待用户重装 0.3.20 后确认）。

### 追加修改（同日，用户复核后）

用户指出 review 列的「继续修改」入口位置不对（渲染在验收区块）且执行链提示出现在验收区。
调整：修改提示词 + 修改按钮移入「执行工作方式」区块，按钮按列切换语义（doing 列
「在 {agent} 中执行」/ review 列要求修改时「在 {agent} 中修改」，无实现绑定或无项目任务
不显示）；搬迁时补两处守卫——显式排除无项目任务（原借验收区隐藏）、入口不依赖宿主连接
（保持浏览器独立模式可见但禁用的原行为）。验证：UI 测试 89/89、build:plugin +
verify-plugin ALL PASS、浏览器独立验收含截图（docs/acceptance/20261008-fix-entry-in-execution.png）。

### 同日追加二：等待输入禁用修改 + 复查按钮轮次号

用户复核：① 实现会话「等待输入」时应禁用修改入口——`reviewBlockReason('review-fix')` 的
busy 条件扩展含 waiting；② 「继续验收」按钮改为「在 {agent} 中验收（Round #{number}）」，
number 为待开启轮次。UI 测试 89/89（含新增断言）、build:plugin + verify-plugin ALL PASS。

### 变更统计

- **统计口径**：工作区含会话前未提交改动，单文件 numstat：
  ui/src/components/TaskCard.tsx、ui/src/i18n/messages.ts、ui/src/mcp/appsClient.ts、
  extension/src/widget.mjs、extension/src/plugin-server.mjs、plugin.json×2、marketplace.json、
  scripts/verify-plugin.mjs、mcp/test/apps-report.test.ts、ui/test/native-execution.test.mjs。

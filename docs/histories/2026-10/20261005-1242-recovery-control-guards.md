## [2026-10-05 12:42 +0800] | 任务：修复恢复入口规则与四项 UI 失败

### 执行上下文

- **Agent ID**：`codex（主代理与独立实现、审查代理）`
- **Base Model**：`GPT-6（具体变体未知）`
- **Runtime**：`Codex Desktop，本地 macOS 工作区，Node.js 22.22.0`
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main（未提交）`
- **关联计划**：[native-execution-report-card](../../exec-plans/completed/native-execution-report-card.md)

### 用户诉求

> 在前轮代码缺陷复验通过、仍有四项 UI 测试失败及宿主验收待取证后，用户要求“直接修复”。

### 变更概览

**影响范围**：`ui/`、原生执行契约、插件 UI 产物、验收报告与现有执行计划。

- **恢复入口规则**：依据 `20261003-1520-sidebar-visual-refresh.md` 的最终定稿，
  仅当前创建流程的 pending/delivered/claimed/created/bound 请求、更新时间严格超过
  五分钟且未归档时显示核对按钮；删除误入显示白名单的 blocked/uncertain。
- **测试修复**：保留 blocked 原因、真实会话、继续及无结果禁用断言，修正四项过时的
  核对入口预期；新增窄详情与宽抽屉的时间阈值、错误/缺失/未来时间、旧轮次请求测试。
  已有断连、消息能力、身份、看板范围、归档守卫继续验证。
- **契约澄清**：分别说明 UI 入口显示条件和底层 purpose=status 的能力范围，
  核心状态机及核对能力未调整。
- **交付**：重建插件产物，更新验收报告与 active 计划，保存五张浏览器夹具截图。

### 设计动机

旧测试要求运行、阻塞和终态请求始终显示核对入口，测试数据没有 updatedAt，
与用户最终确定的创建流程超时规则不一致；当前源码又将 blocked/uncertain 错纳入
白名单。修复业务显示条件并补边界断言，保证测试验证真实规则。

底层 status 核对工具仍允许更广的状态，现有执行请求、回执、聊天和工作区不做迁移。
同一源码组件承载宽窄视图；无需额外测试依赖。回滚本次源码、测试与契约增量后重建
插件即可，数据无回滚需求。

### 验证结果

- `pnpm test`（含 build）：300/300 通过。
- `node --test ui/test/*.test.mjs`：55/55 通过，四项失败全部关闭，新增两项边界测试。
- UI typecheck、`pnpm build:ui`、`pnpm build:plugin`、`pnpm verify:plugin`、
  `pnpm smoke` 与 `git diff --check`：通过。测试与构建命令设 60 秒硬超时，无超时。
- 独立审查代理复核本轮增量，未发现回归或弱化语义断言。
- 浏览器夹具：宽视图与 420×900 窄栏验证超时入口、blocked/fresh 隐藏行为、归档
  字段锁定与断连禁用；实际 React 界面接收模拟 SDK toolresult 后锁定所属仓库、
  自动打开详情，重复相同 taskId 在用户关闭详情后不重开，归档任务也可聚焦。
- 夹具禁止投递消息、打开真实聊天和业务写操作，使用临时 bridge 与临时数据；
  服务和浏览器页已结束。没有安装依赖、操作真实看板、提交或修改宿主设置。
- **未覆盖**：真实 Codex 宿主加载新版插件后，真实回执触发卡片以及宿主透传上下文。
  浏览器模拟验证应用侧收到上下文后的行为，不能证明宿主出卡。该项继续保留在 active 计划。

### 变更统计

**统计口径**：工作区已有两项功能的大量未提交改动，按本轮编辑前快照与当前文件执行
`git diff --no-index --shortstat`、`--numstat`，排除此前改动与本历史记录。
五张新截图按二进制文件计数。插件 server 重建后内容与本轮前一致，不计变更。

- **变更文件数**：11（6 个文本文件、5 张新截图）
- **新增行数**：+110
- **删除行数**：-23

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/components/TaskDetail.tsx` | 3 | 4 |
| `ui/test/task-detail-controls.test.mjs` | 58 | 12 |
| `docs/native-execution-contract.md` | 5 | 1 |
| `docs/acceptance/20261005-deadline-and-report-card.md` | 36 | 1 |
| `docs/exec-plans/active/native-execution-report-card.md` | 7 | 4 |
| `plugins/tasklane/kanban-widget.html` | 1 | 1 |
| `docs/acceptance/20261005-recovery-*.png`（5 张） | bin | bin |

### 修改文件

- `ui/src/components/TaskDetail.tsx`
- `ui/test/task-detail-controls.test.mjs`
- `docs/native-execution-contract.md`
- `docs/acceptance/20261005-deadline-and-report-card.md`
- `docs/exec-plans/active/native-execution-report-card.md`
- `plugins/tasklane/kanban-widget.html`（构建产物）
- `docs/acceptance/20261005-recovery-{wide,blocked,narrow,archived,disconnected}.png`

### 后续事项

真实宿主出卡、展开与范围隔离仍按报告卡片计划取证；最新插件产物已就绪。

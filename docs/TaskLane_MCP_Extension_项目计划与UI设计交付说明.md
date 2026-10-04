# TaskLane MCP Extension

## 项目计划与 UI 设计交付说明

> 用于 Open Design 产出 Sidebar / Expanded Board 高保真设计

TaskLane MCP Extension

项目计划与 UI 设计交付说明

用于 Open Design 产出 Sidebar / Expanded Board 高保真设计

| 产品形态 | Codex 侧边栏中的 MCP-native 编程任务看板 |
| --- | --- |
| 主要参考 | Cline Kanban（主参考）+ Vibe Kanban（UX 参考） |
| 核心架构 | Sidebar UI → MCP Contract → Board Core → Git / Session |
| 第一版目标 | 建立“任务 → 分配给 Agent → 执行 → Review → Done”的可验证闭环 |
| 设计优先级 | 窄侧栏优先；展开态作为第二视图，不以桌面全宽 Kanban 反推侧栏 |

> 设计总原则： 这是一个“面向 Codex 工作流的执行看板”，不是传统 Trello 的缩小版。窄侧栏下优先可读性、任务状态与 Agent 执行反馈；展开后才展示多列 Kanban。

# 1. 项目目标与产品定义

目标是在 Codex/Cowart 已验证可用的侧边栏扩展能力上，交付一个面向 coding-agent 工作流的 Kanban。产品既允许用户手动管理任务，也允许 Agent 通过 MCP tools 操作同一份任务数据。UI 与 Agent 不各自维护状态。

- 用户可以在侧边栏快速查看当前项目任务、状态、优先级、分支与 Agent 执行状态。

- 用户可以创建任务、移动状态、分配给 Agent、查看执行进度、查看 Diff/Review 信息。

- Agent 可以通过 MCP tools 查询、创建、更新、移动和领取任务。

- 任务、Git worktree/branch、Codex session 之间建立稳定关联。

- 第一版不实现完整 IDE、云端协作套件或复杂多 Agent 编排。

## 1.1 第一版成功标准

| 验收项 | 定义 |
| --- | --- |
| 任务闭环 | Backlog/Ready → Doing → Review → Done 可完整流转 |
| Agent 闭环 | 任务可 Assign to Agent，UI 能明确展示 Running / Waiting / Failed / Completed |
| Git 闭环 | 任务能显示 branch/worktree，并在 Review 阶段展示变更摘要 |
| MCP 闭环 | UI 与 Agent 均通过统一 MCP contract 修改任务 |
| 侧栏可用性 | 在 360–480 px 窄侧栏宽度下无需缩放即可完成主要操作 |

# 2. 开源参考与复用策略

主参考 Cline Kanban：重点复用其 coding-agent 看板的任务生命周期、任务与 worktree/session 绑定方式、Agent 状态表达和 Diff Review 结构。Vibe Kanban 作为交互补充参考，主要吸收任务详情、执行反馈和 Review 体验。

> 不要直接照搬： 不直接移植完整 agent runtime、PTY orchestration、remote workspace、多 provider 抽象和完整 IDE 功能。第一版保持 MCP contract 清晰、Board Core 可独立测试。

## 2.1 建议复用的设计模式

| 模式 | 说明 |
| --- | --- |
| Task lifecycle | Backlog / Ready / Doing / Review / Done |
| Agent state | Idle / Assigned / Running / Waiting / Failed / Completed |
| Task ↔ Git | repo / base branch / task branch / worktree / diff summary |
| Review | 文件变更数、+/- 行数、主要文件列表、进入 Diff 入口 |
| Execution visibility | 让用户能判断 Agent 是否正在工作、等待输入、失败或已完成 |

# 3. 总体架构

```text
Codex / Cowart Host
│
├── Sidebar Extension
│     └── React UI
│
├── MCP Tools
│     ├── board_list
│     ├── task_list
│     ├── task_get
│     ├── task_create
│     ├── task_update
│     ├── task_move
│     └── task_assign
│
└── MCP Server
      └── Board Core
            ├── Tasks
            ├── Git / Worktree
            └── Codex Session State
```

设计层只需要理解三类对象：WorkItem（任务）、Execution（Agent 执行状态）、ChangeSummary（Git 变更摘要）。复杂的底层实现不应暴露到卡片主界面。

# 4. UI 设计总览（Open Design 重点）

设计必须以 Codex 右侧/左侧窄 Sidebar 为第一场景。传统 5 列 Kanban 在 360–480 px 宽度下不可读，因此第一视图采用“状态导航 + 单列任务列表”。当用户展开面板或进入宽视图后，再切换到经典多列 Kanban。

## 4.1 设计画板与响应式规格

| 画板 | 建议尺寸 | 用途 | 主要布局 |
| --- | --- | --- | --- |
| S1 — Narrow Sidebar | 420 × 900 | 主设计稿，优先级最高 | 单列任务流 + 状态 Tab；任务详情替换当前列表 |
| S2 — Compact Sidebar | 360 × 800 | 最窄验收态 | 压缩文本与次要信息；保留主要 CTA |
| S3 — Expanded Panel | 760 × 900 | 展开态 | 可展示 2–3 列，支持详情侧抽屉 |
| S4 — Full Board | 1280 × 900 | 可选增强稿 | 5 列完整 Kanban + 详情 drawer |

> 设计要求： 请先完成 S1，再用同一套组件系统推导 S2/S3/S4。不要先画 1280 宽的大看板再简单缩小。

## 4.2 信息架构

```text
Sidebar
├── App Header
│   ├── Project / Repo selector
│   ├── Sync / connection state
│   └── More / Settings
│
├── Status Summary
│   ├── Backlog count
│   ├── Ready count
│   ├── Doing count
│   ├── Review count
│   └── Done count
│
├── Status Tabs
│   └── active column selector
│
├── Task List
│   ├── Task Card
│   ├── Task Card
│   └── ...
│
└── Sticky Action Area
    ├── + New Task
    └── optional: Filter / Search
```

# 5. Sidebar 主界面：Narrow Board

这是产品默认首页。用户打开侧边栏后 1 秒内应该知道：当前项目、正在做什么、Agent 是否在运行、有哪些任务需要 Review。

## 5.1 顶部 App Header

| 区域 | 设计要求 |
| --- | --- |
| 左侧 | 项目/Repo 名称；超长时单行截断。可点击切换项目。 |
| 中间/次要 | 当前 branch 或 workspace 名称，可隐藏到二级信息。 |
| 右侧 | 连接状态点 + More 菜单。连接异常时用明确文字，不只用颜色。 |

## 5.2 状态摘要与 Status Tabs

建议把“统计”和“切换”合并成同一组状态导航。每个 Tab 显示状态名与数量，例如 Doing 2、Review 1。在 420 px 下横向可滚动，但默认必须完整露出 Doing 与 Review。

- 顺序：Backlog → Ready → Doing → Review → Done。

- Doing、Review 是最重要状态，视觉权重高于 Backlog/Done。

- Tab 激活态必须同时有形状/底纹变化，不能只用颜色。

- 当 Review > 0，可用轻量提示点，但避免强红色造成错误语义。

## 5.3 Task Card 结构

卡片必须支持快速扫读。主卡片不要塞入描述正文、完整路径或日志。建议从上到下分为四层：

| 层级 | 内容 | 视觉优先级 |
| --- | --- | --- |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |
| 1. Header | TASK-128 · P1/P2 · optional tag | 低到中 |
| 2. Title | Implement OAuth callback | 最高；最多 2 行 |
| 3. Execution | Agent Running / Waiting / Failed；Human | 高，执行中必须明显 |
| 4. Context | branch 名称 + changed files / +184 -39 | 中；无数据时隐藏 |

```text
┌──────────────────────────────────┐
│ TASK-128                    P1    │
│ Implement OAuth callback          │
│                                  │
│ ● Agent running                  │
│ feat/oauth-callback              │
│ 6 files   +184  -39              │
└──────────────────────────────────┘
```

## 5.4 Card 状态变体

| 状态 | 卡片表现 |
| --- | --- |
| Human / 未分配 | 不显示 Agent 状态，底部可显示“Assign to Agent”轻量入口。 |
| Assigned | 显示“Agent assigned”，等待启动。 |
| Running | 显示活动指示 + 当前阶段短文案，例如“Editing 3 files”。 |
| Waiting | 显示“Waiting for input”，卡片需要比 Running 更可操作。 |
| Failed | 明确失败图标/文案 + Retry / Open details；不能只显示红点。 |
| Completed → Review | 显示变更摘要 + “Review changes”主要动作。 |

## 5.5 主界面操作

- 单击卡片：进入 Task Detail。

- 拖拽：在展开态用于列间移动；窄侧栏不要依赖拖拽作为唯一移动方式。

- 窄侧栏移动状态：Task Detail 中提供 Status selector。

- New Task：底部 sticky primary button 或右下角轻量 FAB，两者选其一，不同时存在。

- 搜索/过滤：第一版可以放到 More 内；任务数超过约 20 后再提升为常驻控件。

# 6. Task Detail：任务详情页

窄侧栏中，Task Detail 不建议做覆盖式 drawer；直接替换列表内容，并提供明确 Back 返回。这样能保证 360–420 px 宽度下信息层级稳定。

| 模块 | 内容 |
| --- | --- |
| Top Bar | Back · TASK-128 · More |
| Title | 可编辑标题；2–3 行以内 |
| Status & Priority | Status selector + Priority |
| Description | Markdown 简述；默认折叠到合理高度 |
| Assignee / Execution | Human / Agent；Assign to Agent / Stop / Retry |
| Git Context | Repo、base branch、task branch、worktree |
| Execution Timeline | Started → Editing → Tests → Waiting/Completed；只展示关键事件 |
| Change Summary | files changed、+/-、主要文件列表 |
| Primary CTA | 根据状态变化：Start / Open session / Review changes / Mark done |

```text
← TASK-128                              ⋯

Implement OAuth callback

[Doing ▾]              [P1 ▾]

Add callback handler, state validation and tests.
────────────────────────────────────────
Assigned to
Agent                         ● Running

Current activity
Editing auth/callback.ts
Started 4m ago
────────────────────────────────────────
Git
feat/oauth-callback
6 files changed   +184   -39

auth/callback.ts
auth/session.ts
tests/oauth.test.ts
────────────────────────────────────────
[ Open Codex Session ]
[ Review Changes ]
```

## 6.1 Assign to Agent 交互

这是整个产品最关键的 Agent 入口，不能藏在三级菜单。建议流程：

1. 用户打开任务详情，点击 “Assign to Agent”。

1. 如果没有 branch/worktree，由系统自动创建；必要配置放在确认 sheet 内。

1. 按钮立刻变为 Assigned / Starting，避免出现“点了没反应”。

1. 运行后展示 Agent Running，并显示当前阶段，不滚动暴露完整 terminal log。

1. 如果 Agent 需要用户确认，状态变为 Waiting for input，并提供“Open Session”。

1. 完成后任务进入 Review，并把 “Review Changes” 提升为主 CTA。

# 7. Codex Execution UI

Sidebar 不是 terminal。执行信息应做“摘要化”，而不是把完整命令行复制进看板。设计上需要清楚区分任务状态和 Agent 执行状态。

| 概念 | UI 表达 |
| --- | --- |
| Task Status | Doing / Review 等业务状态 |
| Agent Status | Assigned / Starting / Running / Waiting / Failed / Completed |
| Activity | Editing files / Running tests / Preparing diff 等短摘要 |
| Session | 可进入 Codex 原会话/执行上下文 |

> 禁止设计成： 卡片里持续滚动 terminal 文本、长链式 thought/log、密集命令输出。Sidebar 只展示状态和关键事件；需要深入时跳转到 Codex Session。

# 8. Review Changes / Diff 入口

Review 是 coding-agent Kanban 与普通 Kanban 的核心差异。第一版不要求在 420 px 侧栏中完整呈现双栏 diff，但必须清晰展示变更摘要并提供进入 Review 的入口。

| 区域 | 要求 |
| --- | --- |
| Sidebar summary | N files changed、+A/-D、测试状态、关键文件列表 |
| Expanded review | 文件树 + 单文件 diff；760 px 以上可展示 |
| Actions | Open Diff、Request Changes、Mark Done |
| Optional later | Comment on line、stage/unstage、commit/PR |

# 9. Expanded Panel / Full Board

当宽度达到约 760 px 以上，允许从单列模式切换为多列 Kanban。此时可以恢复拖拽，并在右侧打开 Task Detail drawer。

```text
Backlog       Ready          Doing          Review         Done
┌────────┐     ┌────────┐     ┌────────┐     ┌────────┐
│ TASK   │     │ TASK   │     │ TASK   │     │ TASK   │
└────────┘     └────────┘     │ Agent  │     │ Diff   │
                              │ Running│     │ Ready  │
                              └────────┘     └────────┘
```

- 760–899 px：优先 2–3 列横向可滚动，不需要强制同时露出 5 列。

- ≥ 1000 px：可以完整 5 列。

- Task Detail 在宽视图使用右侧 drawer，宽度建议 360–440 px。

- Drawer 打开时 Board 保持上下文，不要整页跳转。

# 10. New Task 创建流程

创建任务需要极简。第一屏只包含最必要字段：

- Title（必填）

- Description（可选）

- Priority（默认 P2 或无）

- Initial status（默认 Backlog/Ready）

- Assign to Agent now（默认关闭）

Repo/branch/worktree 不建议作为普通用户创建任务的必填项。若用户选择立即分配给 Agent，再在第二步处理 Git 上下文。

# 11. 空态、加载态、错误态

| 场景 | 表现 |
| --- | --- |
| 首次进入 / 无任务 | 简洁说明 + Create first task；可提供 2–3 个 coding task 示例模板。 |
| Doing 为空 | 不要显示大插画；显示“没有正在执行的任务” + 查看 Ready。 |
| Review 为空 | 强调“暂无待 Review 变更”，避免制造完成庆祝感。 |
| MCP disconnected | Header 明确提示连接异常；列表可只读保留缓存，操作禁用并解释原因。 |
| Agent failed | 任务卡/详情均有失败状态；提供 Retry 和 Open Session。 |
| Loading | 优先 skeleton card；不要整屏 spinner。 |

# 12. 视觉语言与设计系统方向

整体应贴近开发工具而非消费级项目管理产品：克制、信息密度中等、状态清晰、视觉噪音低。

| 项 | 方向 |
| --- | --- |
| 背景 | 优先兼容 host 的 Light/Dark theme；避免大面积品牌色背景。 |
| 卡片 | 轻边框 + 轻层级，不使用厚阴影。 |
| 圆角 | 中小圆角；不要做成过度柔和的移动端卡片。 |
| 颜色 | 状态颜色仅用于辅助识别；必须同时有文字/图标。 |
| 字体 | 跟随 host UI；代码/branch/path 可使用 monospace。 |
| 图标 | 使用开发工具常见语义：branch、diff、play、stop、retry、warning。 |
| 密度 | 420 px 下单卡高度建议约 96–136 px，取决于是否有 Agent/Git 信息。 |

# 13. MCP Contract 与 UI 映射

| MCP Tool | UI 入口 |
| --- | --- |
| board_list | Project/Repo selector |
| task_list | 当前状态任务列表 / 多列 Board |
| task_get | Task Detail |
| task_create | New Task |
| task_update | 编辑标题、描述、优先级 |
| task_move | Status selector / drag & drop |
| task_assign | Assign to Agent / Human |

# 14. 核心数据模型（供设计理解）

```text
WorkItem {
  id
  title
  description
  status: backlog | ready | doing | review | done
  priority: P0 | P1 | P2 | P3
  assignee: human | agent

  repo
  baseBranch
  branch
  worktreePath

  execution {
    state: assigned | starting | running | waiting | failed | completed
    activity
    sessionId
  }

  changes {
    filesChanged
    additions
    deletions
    testStatus
  }
}
```

设计稿中的每个字段都应有明确用途；没有可见用途的字段不要为了“完整”塞进 UI。

# 15. MVP 范围

| 范围 | 内容 |
| --- | --- |
| 必须有 | Narrow Sidebar、Status Tabs、Task Card、Task Detail、New Task、Assign to Agent、Execution state、Change summary、Review entry |
| 应有 | Expanded Board、拖拽、多列视图、Retry/Stop、空态/错误态 |
| 暂不做 | 多人协作、评论系统、通知中心、完整 terminal、复杂权限、云同步、时间线分析、Sprint/Calendar、完整 PR 管理 |

# 16. 交付给 Open Design 的画面清单

| 编号 | 画面 | 尺寸 | 要求 |
| --- | --- | --- | --- |
| 01 | Narrow Sidebar / Ready | 420×900 | 默认列表，有 4–6 张不同状态卡片 |
| 02 | Narrow Sidebar / Doing | 420×900 | 至少一张 Agent Running 卡片 |
| 03 | Task Detail / Running | 420×900 | 显示 Agent activity、Git、Open Session |
| 04 | Task Detail / Review | 420×900 | 显示 change summary + Review Changes |
| 05 | Task Detail / Failed | 420×900 | 明确错误、Retry、Open Session |
| 06 | New Task | 420×900 | 最小创建表单 |
| 07 | Empty State | 420×900 | 无任务/无 Doing 二选一 |
| 08 | Expanded Board | 760×900 | 2–3 列 + Task Detail drawer |
| 09 | Full Board | 1280×900 | 5 列完整 Kanban，可作为增强稿 |
| 10 | Dark Theme | 420×900 | 建议至少为主界面提供暗色版 |

# 17. Open Design 可直接使用的设计 Brief

设计一个嵌入 Codex/Cowart 的 coding-agent Kanban sidebar。核心不是传统项目管理，而是管理“任务 + Agent 执行 + Git 变更 + Review”。

主画板 420×900。窄侧栏不要画 5 列 Kanban；使用顶部项目头部、状态 tabs（Backlog / Ready / Doing / Review / Done）、单列任务卡片和 sticky New Task。卡片重点展示 TASK ID、标题、优先级、Agent 执行状态、branch、files changed / additions / deletions。执行中的卡片要明显显示 Agent Running；等待用户输入显示 Waiting for input；失败显示 Failed + Retry；完成后进入 Review，并突出 Review Changes。

Task Detail 在窄侧栏中采用“替换列表”的页面，而不是抽屉。详情包含：标题、status、priority、description、assignee、Assign to Agent、Agent activity、Git branch/worktree、变更摘要、Open Codex Session、Review Changes。不要在侧栏中塞完整 terminal log。

扩展到 760px 后允许 2–3 列 Kanban；1280px 可做 5 列完整 Board。宽视图使用右侧 Task Detail drawer。整体视觉接近现代开发工具：中等信息密度、轻边框、少阴影、兼容 light/dark theme、branch/path 使用 monospace、颜色仅辅助状态识别。

需要输出：Narrow Ready、Narrow Doing、Task Running、Task Review、Task Failed、New Task、Empty State、Expanded Board，以及至少一个 Dark Theme 主画面。

# 18. 实施里程碑

| 阶段 | 交付 |
| --- | --- |
| M0 — 源码拆解 | 确认 Cline Kanban 可复用组件、状态模型与需要删除的 runtime 耦合 |
| M1 — MCP Core | 实现 Board Core + task CRUD/move/assign tools |
| M2 — Sidebar MVP | 实现 420 px 单列 Board、Task Detail、New Task |
| M3 — Codex Execution | 接入 session state、Assign/Retry/Stop、Activity 摘要 |
| M4 — Git / Review | 接入 branch/worktree/change summary、Review entry |
| M5 — Expanded Board | 加入多列 Kanban、拖拽、detail drawer |
| M6 — QA | Light/Dark、360–760 px 响应式、错误态、断连态、性能与可访问性 |

# 19. UI 验收清单

- 420 px 宽度下，主要功能无需横向滚动即可完成。

- 用户 1 秒内可识别当前项目、当前状态视图、Agent 是否在执行、是否有待 Review 任务。

- 任务状态与 Agent 状态视觉上明确区分。

- Assign to Agent、Open Session、Review Changes 三个关键动作在对应状态下清晰可见。

- Failed / Waiting 状态不依赖颜色表达。

- Narrow Sidebar 不依赖 drag & drop；所有状态变化有可点击替代路径。

- branch、diff 数字、路径信息不会抢过任务标题和执行状态。

- Light / Dark theme 均有足够对比度。

- 长任务标题、长 branch 名称、无 Git 数据、无 Agent 数据都有合理降级。

- MCP 断连时保留上下文并明确提示，避免把连接错误误认为任务失败。

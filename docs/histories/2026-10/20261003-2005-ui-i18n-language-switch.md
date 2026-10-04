# [2026-10-03 20:05 +0800] | 任务：界面中英文 i18n 化与 Header 语言切换

## 执行上下文

- **Agent ID**：zcode（GLM-5.3）
- **Base Model**：account:zai-individual-coding-plan/GLM-5.3
- **Runtime**：ZCode Desktop（macOS darwin 25.6.0 arm64）
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：detached HEAD（仓库尚无任何提交，全部文件处于 staged A + 工作区修改状态）
- **关联计划**：无（单会话完成，未建执行计划）

## 用户诉求

> 需要补充一个中英文翻译问题，不应该是中(英) 或只有英文的写法，占地方，也不系统，右上角增加一个中英文切换。

过程中用户追加四条交互修正：

1. 搜索从「三个点」菜单前置为独立入口；主题与语言用一个 settings icon 的菜单显示。
2. 大屏展开显示，小屏使用 menu。
3. （确认）现在的大屏布局是对的，只需把搜索提前。
4. （最终收敛）现在大屏上的操作就是对的，只需要在小屏把语言/主题移到 menu item 中；语言用与大屏一致的切换，主题用 toggle。

## 变更概览

**影响范围**：`ui/`（全部组件、状态层、i18n 新模块、样式）；另更新 `ui/README.md`。core/mcp/bridge 无改动。

**主要操作**：

- **新增 `ui/src/i18n/`**：`messages.ts`（约 190 键 zh/en 双语字典，zh 为键权威来源、en 以 `Record<MessageKey, string>` 强制全覆盖；`translate()` 纯函数 + 模块级 `currentLang` 供非 React 路径取词；`statusKey/eventKey/execKey` 枚举映射）与 `index.tsx`（`LangProvider`/`useLang`，挂载与切换时同步 `<html lang>`）。
- **全量文案迁移**：AppHeader、StatusTabs、TaskCard、TaskDetail、NewTaskForm、TaskList、BoardWide、DisconnectedBanner、AddBoardForm、RepoPicker、BoardContext、useTaskActions、mcp/types（删除 `STATUS_LABEL`/`EVENT_LABEL`，`timeAgo` 取词）与 mcp/client、appsClient 错误消息全部改为 `t()`；消除「刷新（task_list）」「添加仓库（board_create）」「Agent assigned · 等待启动」等混排与纯英文写死；toast 统一 `task_move(...) 成功/OK` 格式（工具名保留为操作语义）。
- **Header 响应式切换入口**：宽视图（≥760px）保持原布局，右上角平铺「中/EN」分段控件（`LangSwitch`）与主题图标；窄栏新增 `HeaderSettings`（设置 ⚙ icon → 菜单：语言行=与大屏同款分段控件、主题行=toggle 开关），搜索/刷新仍在「更多 ⋯」菜单。`AppHeader` 增加 `wide` prop（BoardWide 传入）。
- **语言持久化与检测**：localStorage `tasklane-lang` > 浏览器语言（zh* → zh）> 默认 zh；写入 MCP 存储的数据（`execution.activity` 前缀等）保持语言无关。
- **修复与集成**：新增 `agoText()`（`{time} 前/ago` 封装，「刚刚/just now」自带时态不拼后缀），修正 TaskDetail/ArchivedView 的「刚刚 前」拼接；`detail.archivedAgo`/`detail.archivedBanner` 键值同步调整。
- **styles.css**：`.lang-switch` 紧凑分段、`.settings-menu`/`.menu-row`/`.menu-label` 菜单行、`.toggle`（track+knob，选中=深色）。

## 设计动机

- 混排文案（中(英)）既占空间又不可系统维护，改为键值字典后新增文案必须双语成对（类型检查强制），从源头杜绝混排。
- 语言状态需要被非 React 代码（client 错误、`timeAgo`）读取，采用「Provider 状态 + 模块级镜像」双轨：`applyLang` 在 setState 前同步模块变量，保证任意调用点取到最新语言。
- 宽窄两套入口是用户逐条确认的收敛结果：大屏保持既有平铺操作零迁移成本，小屏节省横向空间。
- 与并行归档任务（另一会话，`ArchivedView`/`ArchiveAllButton`/`archive.*` 键）在同一工作区叠加开发：对方复用了本次的 i18n 基建，本任务对其两处「{time} 前」拼接做了同源修复，无文件级冲突。

## 验证结果

- 命令：`pnpm --filter @tasklane/ui typecheck` 通过；`pnpm build:ui` 通过（319.98 kB js / 23.96 kB css）；`pnpm build`（core/mcp）通过。
- 手工验证（内置 Chrome/IAB，bridge `PORT=7481` + 临时 `TASKLANE_HOME=/tmp/tasklane-i18n-verify/home` + 临时 Git 仓库，未触碰真实看板）：
  - 窄栏 420px：默认语言跟随浏览器（en-US→EN）；设置 ⚙ 菜单含语言（中/EN 分段）与主题 toggle，切换即时生效且持久化（`tasklane-lang`/`tasklane-theme`/`<html lang>`）。
  - 中文态全量走查：Header/Tab（待办/就绪/执行中/待审查/已完成）/卡片（人工、指派 Agent、Agent 已指派 · 等待启动）/详情（状态、优先级、指派对象、时间线事件、Git 上下文、变更摘要）/添加仓库表单/新建任务表单/空态与 toast。
  - 任务流转：创建 TASK-101 → 指派（自动建分支 `agent/TASK-101-i18n`）→ 启动 → 详情时间线；toast 为 `task_create/task_assign/task_move(...) 成功`。
  - 宽屏 1280px：中/EN + 主题图标平铺、⋯ 菜单（Search/Refresh）5 列 Kanban；EN 全量走查（含断连横幅双语）。
  - 搜索过滤 TASK-101 命中 Doing 列；kill bridge → 英文断连横幅 → 重启后自动重连、任务恢复、语言保持 EN。
  - 修复确认：开始时间显示「8m 前」而非「刚刚 前」。
- 未覆盖场景：`project-error` 错误空态（需 MCP Apps 宿主 `open_tasklane` 上下文，独立 bridge 模式无法触发，文案已入字典）；IAB 视口调整不触发 `matchMedia` change 事件（环境怪癖，reload 后宽窄切换正常，真实浏览器窗口不受影响）。
- 工具链怪癖记录：IAB 内 Playwright 动作式 `click` 对部分按钮超时（fill 正常），验证改用 DOM `el.click()`，等价触发 React 合成事件。

## 变更统计

> 仓库无任何提交（detached HEAD、全量 staged A），基线取 index；`git diff --shortstat -- ui/src` = 18 files, +627 −266。其中 `App.tsx`、`BoardWide.tsx`、`TaskDetail.tsx`、`BoardContext.tsx`、`useTaskActions.ts`、`styles.css` 含并行归档任务的叠加改动，无法按行分离；本任务独有的新文件（i18n/、LangSwitch、HeaderSettings，共 6 文件）为未跟踪状态不计入 diff。排除历史记录自身。

- **统计口径**：工作区 vs index，仅 `ui/src`；含共享文件中的并行改动。
- **变更文件数**：18（另有 6 个未跟踪新文件 + `ui/README.md`）
- **新增行数**：+627
- **删除行数**：−266

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/i18n/messages.ts`（新，未跟踪） | ~460 | 0 |
| `ui/src/i18n/index.tsx`（新，未跟踪） | ~50 | 0 |
| `ui/src/components/LangSwitch.tsx`（新，未跟踪） | ~30 | 0 |
| `ui/src/components/HeaderSettings.tsx`（新，未跟踪） | ~55 | 0 |
| `ui/src/components/AppHeader.tsx` | 55 | 23 |
| `ui/src/components/TaskDetail.tsx` | 95 | 64 |
| `ui/src/components/TaskList.tsx` | 57 | 43 |
| `ui/src/state/BoardContext.tsx` | 111 | 9 |
| `ui/src/styles.css` | 86 | 0 |
| `ui/src/components/TaskCard.tsx` | 33 | 16 |
| 其余 9 个迁移文件 | 130 | 95 |

## 修改文件

- `ui/src/i18n/messages.ts`、`ui/src/i18n/index.tsx`（新增）
- `ui/src/components/LangSwitch.tsx`、`ui/src/components/HeaderSettings.tsx`（新增）
- `ui/src/App.tsx`
- `ui/src/components/`：AppHeader、StatusTabs、TaskCard、TaskDetail、NewTaskForm、TaskList、BoardWide、DisconnectedBanner、AddBoardForm、RepoPicker、icons、ArchivedView（拼接修复）
- `ui/src/state/`：BoardContext.tsx、useTaskActions.ts
- `ui/src/mcp/`：types.ts、client.ts、appsClient.ts
- `ui/src/styles.css`、`ui/README.md`

## 后续事项

- 窄→宽实时切换在 IAB 不可测（环境怪癖），建议真实浏览器窗口复核一次。
- `project-error` 空态的双语文案待宿主嵌入场景回归时复核。
- 示例模板（`list.tpl1..3`）已双语化；任务标题等用户数据不翻译（设计如此）。

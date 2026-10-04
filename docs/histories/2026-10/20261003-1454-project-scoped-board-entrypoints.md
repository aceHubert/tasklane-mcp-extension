## [2026-10-03 14:54 +0800] | 任务：实施项目与全局看板入口

### 执行上下文

- **Agent ID**：codex（ZCode 会话内实施）
- **Base Model**：GLM-5.3（account:zai-individual-coding-plan）
- **Runtime**：ZCode 桌面端，macOS darwin 25.6.0 arm64
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main（仓库尚无任何提交，HEAD 未生成；全部文件处于已暂存/工作区状态）
- **关联计划**：`docs/exec-plans/completed/project-scoped-board-entrypoints.md`（已归档）
- **前置任务**：[多仓库看板隔离](./20261003-1422-multi-repo-board-isolation.md)（同日完成）

### 用户诉求

> project-scoped-board-entrypoints.md 继续实施这个任务

按执行计划交付两种打开入口：项目聊天内 `open_tasklane({ projectDir })`
锁定当前项目看板（未登记自动注册），全局侧边栏 `open_tasklane({})`
提供多仓库管理界面；两种入口共用同一份共享数据。

### 变更概览

**影响范围**：`extension/src/`、`packages/core/src/{git,engine}.ts`、`ui/src/`、
`scripts/{verify-plugin,git-verify}.mjs`、`README.md`、`WORKFLOW.md`、
`ui/README.md`、`extension/README.md`

**主要操作**：

- **打开工具（extension）**：`open_tasklane` 经 zod 声明 `projectDir?/baseBranch?`；
  空对象全局模式；空白/相对路径返回 `VALIDATION`（不误入全局）；项目模式返回
  `mode/boardHome/projectDir/repoRoot/lockedBoardId/boardName`；注册失败返回错误，
  不回退全局第一个仓库。
- **核心层**：新增 `GitService.identifyRepo`（仓库身份识别，不含基线校验）与
  `BoardEngine.resolveProjectBoard`（已登记按身份复用、忽略无效 baseBranch；
  未登记才全量校验，基线缺省 `main`）；`backfillBoardRepoKeys` 改用 identifyRepo
  （旧看板基线漂移不阻止身份回填）。
- **UI 双模式**：`appsClient` 经 ext-apps `toolresult`（ONE_SHOT，connect 前注册）
  接收打开上下文，以 `window.name` 缓存（iframe 重载恢复；不用 sessionStorage——
  其按 tab+origin 共享会串板）；`BoardContext` 新增 `widgetMode/projectCtx`，
  项目模式锁定 `lockedBoardId`（不读写全局 localStorage）、refresh/switchBoard/
  addBoard 全部按模式守卫；project-error 错误空态禁用一切写入口（宽窄视图一致）；
  AppHeader 项目模式显示 🔒 项目名与工作区路径、隐藏选择器/添加入口。
- **验证脚本**：verify-plugin 扩展为 9 工具 + 项目/全局契约（自动注册、幂等、
  子目录归位、空白/相对路径拒绝、默认基线缺失报错、显式基线注册、共享数据）；
  git-verify 新增 S9（resolveProjectBoard 引擎语义）。

### 设计动机

- 项目模式上下文只随工具结果下发给对应 widget，服务端不保存全局"当前仓库"，
  满足"项目 A、项目 B、全局同时打开互不串用"；`window.name` 按 frame 独立且
  重载保留，正好匹配 widget 生命周期（宿主重建 iframe 即新实例、自然清空）。
- `resolveProjectBoard` 与 `registerBoard` 分工：显式注册时用户指定的基线错误
  应当报错；项目自动登记时已登记仓库按身份直接复用（后续传入的 baseBranch
  无效不应拒绝已绑定仓库，也不覆盖原配置）。
- `projectDir`（聊天工作区，保留 worktree/子目录原路径）与 `repoRoot`（看板
  仓库身份）分开返回，调用方不混淆二者。
- 回滚：不涉及存储版本迁移；已自动登记的仓库与任务保留，恢复原打开入口即可。

### 验证结果

- 命令与结果（全部通过，每次后台命令均带 60s 硬超时）：
  - `pnpm build` / `pnpm test`（39/39）✅
  - `pnpm smoke` ✅、`pnpm verify:git`（含新增 S9）✅、`pnpm verify:twoproc` ✅、`pnpm verify:bridge` ✅
  - `pnpm --filter @tasklane/ui typecheck` ✅、`pnpm build:ui` ✅
  - `pnpm build:plugin` ✅（server 772KB / widget 515KB）、`pnpm verify:plugin` ✅（26 项全过）
- 手工验证及环境（mock 宿主 + 真实插件 widget，内置 Chrome 工作流）：
  - 自建 mock 宿主页按 ext-apps postMessage 协议（ui/initialize 握手 →
    toolresult 下发 → tools/call 转发 bridge WebSocket）驱动真实 widget bundle，
    双 iframe 模拟项目 X / 项目 Y（或全局）widget 并存；
  - 项目 X / 项目 Y 并存各自锁定（🔒 标题、无选择器/⊞、计数独立）✅；
  - Y 中创建任务后 X 计数不变（不串板）；widget 重载经 window.name 恢复锁定 ✅；
  - 项目失败态：错误空态 + 头部 ⚠ 标题 + 新建按钮禁用 + 重载仍恢复错误态 ✅；
  - 切回全局：选择器/添加入口恢复，三看板与计数正确 ✅；
  - 修复过程中发现并解决：① 连接 effect 依赖闭环导致 widget 反复重握手
    （重建风暴，mock 日志定位）；② project-error 模式头部泄漏选择器且
    switchBoard/addBoard 守卫未覆盖（截图视觉检查发现，DOM 与宿主日志裁决定位）。
- 未覆盖场景：Codex 原生宿主（真实项目聊天/全局侧栏）内验收——宿主接入本身
  未落地，属后续工作；worktree 工作区打开场景由 verify:plugin/git-verify 的
  子目录归位用例覆盖。

### 变更统计

> 统计口径：仓库尚无提交，工作区同时含同日两个任务（多仓库隔离 + 本任务）与
> 并行重命名任务的改动，无法按提交切割；下表为本任务实际触碰文件及估算行数
> （剔除多仓库任务已记录部分）。排除 `docs/exec-plans/active/` 的计划移动。

- **变更文件数**：17（含归档计划）
- **新增行数**：约 +700
- **删除行数**：约 -65

| 文件 | 本任务新增 | 本任务删除 |
| --- | ---: | ---: |
| `extension/src/widget.mjs` | 124 | 20 |
| `extension/src/plugin-server.mjs` | 1 | 1 |
| `packages/core/src/git.ts` | ≈45 | 8 |
| `packages/core/src/engine.ts` | ≈40 | 4 |
| `ui/src/mcp/appsClient.ts` | 88 | 1 |
| `ui/src/state/BoardContext.tsx` | ≈110 | 12 |
| `ui/src/components/AppHeader.tsx` | ≈19 | 1 |
| `ui/src/components/TaskList.tsx` | ≈28 | 0 |
| `ui/src/components/BoardWide.tsx` | 19 | 0 |
| `ui/src/components/NewTaskForm.tsx` | ≈10 | 2 |
| `ui/src/App.tsx` | 6 | 2 |
| `scripts/verify-plugin.mjs` | 116 | 16 |
| `scripts/git-verify.mjs` | 35 | 0 |
| `extension/README.md` | ≈28 | 1 |
| `WORKFLOW.md` | 20 | 0 |
| `ui/README.md` / `README.md` | ≈8 | 1 |
| `docs/exec-plans/completed/project-scoped-board-entrypoints.md` | ≈35 | — |

### 修改文件

- `extension/src/{widget,plugin-server}.mjs`
- `packages/core/src/{git,engine}.ts`
- `ui/src/mcp/appsClient.ts`、`ui/src/state/BoardContext.tsx`
- `ui/src/App.tsx`、`ui/src/components/{AppHeader,TaskList,BoardWide,NewTaskForm}.tsx`
- `scripts/{verify-plugin,git-verify}.mjs`
- `README.md`、`WORKFLOW.md`、`ui/README.md`、`extension/README.md`
- `docs/exec-plans/completed/project-scoped-board-entrypoints.md`（归档并更新进度）

注：`ui/src/components/{TaskCard,TaskDetail}.tsx`、`ui/src/state/useTaskActions.ts`、
`ui/src/styles.css` 的差异属同日多仓库任务（已在其历史记录中统计），本任务未改。

### 后续事项

- Codex 原生宿主接入后，在真实项目聊天与全局侧栏复验两种入口（含真实
  worktree 工作区打开场景）；该验收不能由 mock 宿主替代。
- 完整的"当前工作区 Git 状态"面板（从 `projectDir` 读取分支/HEAD/未提交改动）
  为计划明确推迟范围，未登记技术债。

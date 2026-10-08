## [2026-10-05 22:56 +0800] | 任务：无项目执行与非 Git 项目支持落地

### 执行上下文

- **Agent ID**：`claude-code（ZCode 会话，GLM 驱动）`
- **Base Model**：`GLM-5.3-Flash（account:zai-start-plan）`
- **Runtime**：`ZCode Desktop（macOS darwin 25.6.0 arm64，Node 20+ / pnpm workspace）`
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main`（单提交仓库 `ce03e8f chore: initial project`，全部改动未提交）
- **关联计划**：`docs/exec-plans/completed/fix-default-board-projectless-execution.md`（已验收归档）

### 用户诉求

> "fix-default-board-projectless-execution.md 开始实施"。实施中两次澄清：
> ①"无项目的不更新工作区，不参与 review 的流转"；②"记录在任务文件中"；
> ③"没有 workspace 时 review 的 ui 是不显示的吧，我在另一个任务中有确认，
> 因为无法区别 worktree 目录"。压缩脱敏后的版本。

### 变更概览

**影响范围**：`packages/core/`（类型/存储/引擎/原生执行/Git）、`mcp/`（工具注册/处理器/测试）、`ui/`（守卫/状态/组件/i18n）、`extension/`（widget、plugin-server、Skill）、`scripts/`（smoke、git-verify、verify-plugin）、根文档（`docs/native-execution-contract.md`、`WORKFLOW.md`、`README.md`、`AGENTS.md`）。

**主要操作**：

- **操作一（Core）**：`WorkspaceMode` 新增 `projectless`；`ExecutionResult.workspacePath/workspaceOwner` 改为可成对缺省（projectless 拒绝携带）；`ExecutionRequest.repo` 可空；`Board` 新增 `projectDir`（非 Git 项目身份，realPath 规范化）与 `repoConflict`（Git 能力冲突提示）；`GitService.probeRepo` 区分"明确非 Git 目录"（exit 128 + not a git repository）与真实错误（路径不存在、裸仓库、损坏配置按原语义报错）；engine `registerBoard/resolveProjectBoard` 支持非 Git 目录注册（目录幂等去重，Git 仓库仍按 repoKey 归位去重），新增 `refreshBoardGitCapabilities`（按目录当前状态动态采纳/撤销 Git 能力，身份冲突记 `repoConflict` 不自动合并，探测失败记录说明不静默撤销）与 `listBoardsWithRefresh`（15 秒节流，`TASKLANE_GIT=off` 不探测）；native-execution 按看板类型分流：projectless 请求锚定 `repo=null`、绑定只存 threadId/hostId、携带工作区字段一律 `VALIDATION`，无项目看板拒绝 project/worktree/review 请求、外部会话记录与 `task_review_update`；非 Git 项目 project 模式锚定项目目录（绑定 workspacePath=projectDir、owner=user、不带 branch），worktree 请求拒绝；Review 工作区核验 Git 项目走仓库身份、非 Git 项目要求等于 projectDir 且目录存在可访问。
- **操作二（存储）**：`STORE_VERSION` 6→7、`ARCHIVE_VERSION` 2→3；v6→v7 迁移在锁内回填已有 repo 看板的 `projectDir`（等于主仓库根），备份 `.v6.bak`，归档冷文件同批升 v3；`normalizeV4` 增补 `projectDir/repoConflict` 校验与读取期回填；`registerBoard` 锁内按 repoKey/projectDir 双身份去重并幂等补齐。
- **操作三（MCP）**：`task_execution_request` 的 `workspaceMode` 枚举加 `projectless`；`task_execution_bind` 的 `workspacePath/workspaceOwner` 改可选（成对提供或成对省略，projectless 必须省略）；`board_list` 走 `listBoardsWithRefresh`；`board_create` 描述更新为项目目录注册；`mcp/test/projectless-contract.test.ts` 新增 3 项契约测试。
- **操作四（UI）**：`host.ts` 执行/Review 守卫改为接收看板能力对象（`isProjectlessBoard/boardGitCapable`），无项目看板只接受 projectless、非 Git 隐藏 worktree 选项并返回 `gitUnavailable`，无项目任务 Review 返回 `reviewUnsupported`；`TaskDetail` 工作方式默认值按看板类型分流、无项目/非 Git 提示文案、无项目 review 列直接开放 Mark done；任务没有可解析的待验收工作区（pending 且无来源/冲突）时整个验收区不显示（延续另一任务已确认行为）；`AppHeader` 看板选项对非 Git 项目追加「non-Git」标示并提示 repoConflict；`RepoPicker` 增加「使用当前目录」入口，`AddBoardForm` 非 Git 选择时不发送 baseBranch；i18n 中英同步。
- **操作五（Plugin/Docs/版本）**：`WIDGET_URI` 换版 v0315→v0316，插件 0.3.15→0.3.16（plugin.json、marketplace、plugin-server、appsClient、verify-plugin、apps-report 测试同步）；plugin-server instructions 补 projectless/非 Git 语义；SKILL.md 补 projectless target、非 Git 绑定与 Review 排除；契约文档新增「无项目执行与看板类型」章节、迁移章节升 v7；WORKFLOW.md 补无项目/非 Git 流程图与边界；README/AGENTS/extension README 同步。

### 设计动机

把"项目身份"与"Git 能力"拆成两个独立字段（`projectDir` vs `repoKey/repo`），是让"没有 Git"不再表现为"项目不可用"：非 Git 目录用真实路径作为去重与核验身份，Git 能力作为可动态获得/撤销的附加能力而不是准入条件。`repoKey` 非空才启用 worktree/Git 校验分支，避免放宽 Git 校验影响仓库任务的原有守卫。无项目执行按用户澄清走最窄语义：只建立真实会话绑定（threadId/hostId），完全不承载工作区与验收语义，杜绝把当前聊天目录、看板数据目录或其他项目冒充执行目录。存储 v7 迁移只回填 projectDir 不改任务数据，旧版本可通过 `.v6.bak` + 归档 v2 备份回滚。

### 验证结果

- 命令与结果：`pnpm build` 通过；`pnpm test` 328 项全部通过（新增 projectless-execution 6 项、non-git-board 6 项、projectless-contract 3 项及 review 更新守卫断言）；`pnpm smoke` 通过（无项目看板 Review 请求按新语义拒绝）；`pnpm verify:git` 通过（非 Git 注册/去重、能力刷新、文件路径与裸仓库仍明确报错）；`pnpm verify:twoproc`、`pnpm verify:bridge`、`pnpm verify:plugin` 通过；`pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui`、`pnpm build:plugin` 通过。
- 手工验证及环境：独立浏览器（ZCode IAB，420px 窄栏，`TASKLANE_HOME` 临时目录 + bridge 端口 7491）——无项目看板创建 TASK-101 流转 review 后无验收区、Mark done 直接可用；非 Git 目录经表单注册成功，选择器显示「plain-project (0 · non-Git)」，TASK-102 流转 review 后 Mark done 禁用且无实现工作区时验收区隐藏；验收后 bridge 已停止、临时目录已清理。
- 未覆盖场景：Codex 原生宿主端到端（projectless 聊天出现在最近会话、非 Git 目录匹配宿主项目创建 local 聊天、绑定与回执按新契约落库）未执行，已登记技术债（`docs/exec-plans/tech-debt-tracker.md` 2026-10-05 projectless / 非 Git 宿主验收条目）并作为计划交付条件。

### 变更统计

> 工作区包含此前任务的未提交改动且仓库仅有一个初始提交，无法按提交基线精确拆分；以下按本次任务文件路径集合执行 `git diff --numstat -- <files>` 统计（含这些文件上先前任务的未提交部分），新增测试文件按 `wc -l` 计入。历史记录自身不计入。

- **统计口径**：`git diff --numstat` 限定本次任务 44 个文件路径 + 3 个新增测试文件行数；排除 docs/histories 记录自身与无关路径。
- **变更文件数**：约 47（含 4 个新增源码/测试文件与本次历史记录）
- **新增行数**：约 +1620（955 + 新增测试 664）
- **删除行数**：约 -281

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/native-execution.ts` | +160 | -77 |
| `packages/core/src/board-store.ts` | +150 | -47 |
| `packages/core/src/engine.ts` | +180 | -60 |
| `packages/core/test/non-git-board.test.ts` | +300（新增） | — |
| `packages/core/test/projectless-execution.test.ts` | +208（新增） | — |
| `ui/src/host.ts` | +60 | -25 |
| `ui/src/components/TaskDetail.tsx` | +55 | -20 |
| `docs/native-execution-contract.md` | +70 | -15 |
| `WORKFLOW.md` | +65 | -12 |
| 其余（mcp/ui/extension/scripts/docs） | 合计约 +370 | 合计约 -50 |

### 修改文件

- `packages/core/src/work-item.ts`、`board-store.ts`、`engine.ts`、`native-execution.ts`、`git.ts`
- `packages/core/test/{projectless-execution,non-git-board,store,engine,export,native-execution,run-assignee,archive-cold-storage,review-flow}.test.ts`
- `mcp/src/{register,handlers}.ts`、`mcp/test/{projectless-contract,tools,task-export,apps-report}.test.ts`
- `ui/src/host.ts`、`ui/src/state/{nativeExecution,useTaskActions}.ts`、`ui/src/components/{TaskDetail,AppHeader,AddBoardForm,RepoPicker}.tsx`、`ui/src/i18n/{messages,nativeMessages}.ts`、`ui/src/mcp/appsClient.ts`、`ui/test/native-execution.test.mjs`
- `extension/src/{widget,plugin-server}.mjs`、`extension/README.md`、`extension/plugin-src/skills/native-execution/SKILL.md`、`extension/plugin-src/{plugin.json,.codex-plugin/plugin.json}`、`.claude-plugin/marketplace.json`
- `scripts/{smoke,git-verify,verify-plugin}.mjs`
- `docs/native-execution-contract.md`、`WORKFLOW.md`、`README.md`、`AGENTS.md`、`docs/exec-plans/active/fix-default-board-projectless-execution.md`、`docs/exec-plans/tech-debt-tracker.md`

### 后续事项

- Codex 原生宿主端到端验收（projectless 聊天最近会话显示、非 Git 项目匹配宿主项目、绑定回执落库）：登记于 `docs/exec-plans/tech-debt-tracker.md`，通过后计划归档至 `completed/`。
- 原生 `create_thread` projectless target 与宿主项目目录匹配的实际返回字段需在宿主核验，未预设宿主一定返回可用路径。

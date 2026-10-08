# Repository Guidelines

## 项目结构与模块组织

TaskLane（`tasklane`）是基于 pnpm workspace 的本地编程任务看板，使用 TypeScript、React 和 MCP。UI 与 Agent 通过同一套 MCP 契约读写任务，业务规则集中在核心层。

- `packages/core/`：任务模型、状态流转、JSON 存储、执行时间线及 Git/worktree 能力；`src/` 存放实现，`test/` 存放单元测试。
- `mcp/`：stdio MCP 服务、工具注册、参数验证与处理器；`test/` 验证工具契约。
- `ui/`：React + Vite 界面；`components/` 组织视图，`state/` 管理状态和操作，`mcp/` 封装客户端。业务写操作必须通过 MCP，不能直接改写数据文件。
- `packages/bridge/bridge.mjs`：stdio 与 WebSocket 转发、HTTP 静态托管及本地访问校验；保持薄桥职责，不复制核心业务规则。
- `scripts/`：stdio 冒烟、真实 Git、双进程存储与 bridge 验证入口。
- `extension/`：宿主声明、接入约定与图标；`canvas/`：设计资产；`ui/README.md`：界面说明，不是 UI 源码目录。
- `README.md`：面向使用者的安装（Codex 插件）、运行与工具契约说明；`WORKFLOW.md`：开发与使用说明。[多仓库执行计划](docs/exec-plans/completed/multi-repo-board-isolation.md)：已完成的执行计划存档。

### 整体架构

```
Codex Host
│
├── Sidebar Extension (ui, ✅ 已交付)
│     └── React UI（420px 窄栏：状态 Tabs + 单列卡片；≥760px 多列 Kanban + drawer）
│         顶部仓库选择器 + 添加仓库（board_create），切换即时隔离任务与详情
│
├── MCP Tools（mcp, ✅ 已交付）
│     ├── board_list      → UI: 仓库看板选择器（含各看板计数）
│     ├── board_create    → UI: 添加仓库（注册本地 Git 仓库为新看板，同仓库幂等）
│     ├── dir_list        → UI: 本地仓库目录选择器
│     ├── model_list      → UI: 模型下拉候选（codex app-server 只读 model/list，非执行链路）
│     ├── task_list       → UI: 状态任务列表 / 多列 Board（boardId 过滤）
│     ├── task_get        → UI: Task Detail（含执行时间线）
│     ├── task_create     → UI: New Task（归属指定看板）
│     ├── task_update     → UI: 编辑标题/描述/优先级
│     ├── task_delete      → UI: 详情底部删除（仅 backlog，硬删除 + 二次确认）
│     ├── task_execution（action 复合：request/delivery/claim/bind/external_bind/report）→ UI 与 Agent 的执行链
│     ├── task_update（action=review）→ Reviewer/实现 Agent: 多轮验收状态与结论（revision/CAS）
│     ├── task_move       → UI: Status selector / 宽视图拖拽
│     ├── task_update（action=assign）→ MCP 调用方的负责人元数据（仅改变负责人，不启动执行或创建工作区）
│     └── task_export     → UI: 设置菜单「导出报告」（按时间区间导出 Markdown 报告，只读）
│
└── MCP Server（mcp, ✅ 已交付）
      └── Board Core（packages/core, ✅ 已交付，可独立测试）
            ├── Boards        — 多项目看板注册（Git 仓库身份/非 Git 目录去重、能力动态刷新）+ v1–v6→v7 数据升级
            ├── Tasks        — WorkItem 生命周期（boardId 归属）+ JSON 热存储与按看板归档冷存储（v2）
            ├── Git/Worktree — 只读工作区核验与 diff 摘要（按任务看板路由）
            ├── Session      — 执行状态时间线（assigned/running/waiting/failed/completed）
            └── Review       — 独立验收工作流（reviewBinding/reviewExecution 与多轮结论，CAS 更新）

独立运行：packages/bridge（stdio ↔ WebSocket 薄桥 + 静态托管）
```

默认在 Codex 会话中通过 MCP 工具 `open_tasklane` 打开原生应用面板：项目会话显式传入
工作区绝对路径 `projectDir`，全局看板使用 `{}`。插件声明全局与线程入口、`fullscreen`
显示模式及 `ui://` 资源，由宿主读取并渲染；无需浏览器 URL 或本地 bridge。原生宿主内的
显示与交互仍需单独验收。

## 原生执行闭环与宿主能力边界

普通指派和任务阶段是看板操作，不是执行命令。原生执行需要用户明确选择工作方式：
主仓库、独立 worktree、原样复用旧工作区或无项目执行（projectless，仅未绑定仓库的
default 看板：聊天不归属项目、不记录工作区、不参与验收流转）。非 Git 项目看板
（按真实目录注册）在项目目录执行与验收，不能创建 worktree；Git 能力按目录当前
状态动态刷新。对应执行工具如下，完整参数与状态机见
[原生执行契约](docs/native-execution-contract.md)。

| 工具 | 作用 |
| --- | --- |
| `task_execution`（action） | 单工具六分支执行链：`request`（持久请求和 runId，同任务未确认请求合并；`purpose=review` 为独立验收执行，子动作 `requestAction`）/ `delivery`（投递或结果待确认，不伪装失败）/ `claim`（锁内唯一认领，禁止超时抢占）/ `bind`（created→bound，只读核验工作区）/ `external_bind`（非 Codex 会话，provider-local sessionId）/ `report`（匹配任务、看板、threadId/hostId、请求和当前 runId 的真实回执） |
| `task_update`（action=review） | Review 状态更新（revision/CAS）；结论留存，approved 不自动 Done |
| `task_update`（action=update/assign/review） | 字段编辑、指派与验收状态的复合入口（review 分支即原 task_review_update） |
| `task_archive / task_restore / task_archive_done` | 归档、恢复和当前看板批量归档；执行入口同样遵守归档守卫 |

只有真实目标聊天报告 running 才写 startedAt；消息投递、聊天创建、指派或移入 doing
都不证明已运行。reply 保存并投递完整文本，continue/retry 复用绑定聊天与工作区，
不新建聊天。旧 sess-* 仅保留为内部字段，不转换为 threadId 或可打开的会话。

关键设计决策：

- UI 和 Agent 共用 MCP，业务写入不绕过核心和文件锁。回执合并磁盘最新数据，不覆盖并发编辑。
- 新独立工作区由 Codex 管理，TaskLane 不在指派时创建；旧 worktree/分支完整保留，不能静默切回主仓库。
- 无项目执行不记录 workspacePath/workspaceOwner/branch：绑定只需真实 threadId/hostId，
  不把当前聊天目录、看板数据目录或其他项目当作默认执行目录；无项目任务不参与
  Review 流转（purpose=review 与外部会话记录均被拒绝），没有待验收工作区时 UI
  隐藏整个验收区。非 Git 项目绑定 workspacePath=项目目录、owner=user、不带 branch。
- MCP Apps SDK 支持 sendMessage 和 openLink，但标准握手没有原生线程创建/停止能力。
  UI 要求当前已连接、实时识别为 Codex 且支持用户消息，然后直接提交实际任务；
  不再要求 nativeExecution 声明或独立验证会话。接收 Agent 在实际请求内核对原生工具，
  认领时保存自身真实接收身份；当前会话只调用一次 create_thread，把任务 ID 和执行
  回执要求原样分发后即结束，不等待创建结果、不调用 wait_threads/read_thread 获取
  目标身份、不保存绑定、不移动看板列。新聊天凭任务 ID 自行核验真实身份与工作区，
  通过 MCP 工具完成 created→bound 绑定并执行回报；MCP 工具对所有会话通用，绑定与
  回执不依赖会话间通讯，提示词不含会话角色或先后关系说明。
- 身份提示不是认证；不从 URL、已安装应用、SDK 注入、任务描述或旧绑定推测宿主。
- 非 Codex、身份未知、路由缺失时，执行/回复/继续/重试禁用且没有写入副作用。普通编辑、指派、手动流转、归档仍可用。
- 停止一直禁用：未验证可靠中断接口，发“停止”消息或改派 human 都不等于停止。
- 打开聊天仅使用真实绑定和 SDK openLink 尝试 codex://threads/<threadId>；拒绝时明确提示，不复制内部标识冒充真实聊天。
- 不提供 CLI、App Server、后台进程、其他 Agent 或桌面私有注入兜底，不自动提交、合并或清理工作区。
  唯一例外是 `model_list`：每次查询独立 spawn `codex app-server` 只读调用 `model/list`，
  获取与宿主选择器同源的模型目录供 UI 单一模型下拉（不允许手输，默认继承宿主；
  获取失败仅保留继承宿主默认），任何执行、投递与续接都不经过它。
  

## 构建与本地开发

使用 Node.js 20.6 及以上版本和 pnpm。首次使用执行 `pnpm install`；已有锁文件的干净环境可使用 `pnpm install --frozen-lockfile`。

- `pnpm build`：`tsc -b`，按项目引用构建 core 与 mcp；不包含 UI。
- `pnpm --filter @tasklane/ui typecheck`：独立检查 UI 类型。
- `pnpm build:ui`：Vite UI 构建；不能替代 UI 类型检查。
- `pnpm sidebar`：构建 UI 并启动本地 bridge；需要先完成 core/mcp 构建，默认端口为 `7433`。
- `pnpm mcp`：运行已构建的 stdio MCP 服务。
- `pnpm --filter @tasklane/ui dev`：启动 Vite 开发服务器；MCP 连接仍需 bridge 或宿主支持。

构建产物位于各包的 `dist/`，不要手改或提交产物。MCP 标准输出只用于 JSON-RPC，诊断日志写入标准错误。

## 编码风格与命名

遵循现有两个空格缩进、单引号及分号风格。TypeScript 使用严格类型，类型和 React 组件采用 `UpperCamelCase`，函数与属性采用 `lowerCamelCase`，组件文件使用 `.tsx`。core/mcp 使用 NodeNext 模块解析，源码中的相对导入沿用 `.js` 后缀。

使用简体中文交流、编写文档和必要注释。保持模型、存储、业务编排、工具契约与 UI 职责分离；复杂并发和边界处理添加中文注释。仓库尚未配置 ESLint 或 Prettier，不声称相关检查已通过，也不做无关的全文件格式调整。

## 测试与验证

现有自动化测试使用 `node:test` 与 `node:assert`，放在 `packages/core/test/` 和 `mcp/test/`，文件采用 `*.test.ts` 命名。`pnpm test` 先构建，再执行编译后的测试。新增测试优先覆盖状态规则、参数错误、持久化与并发边界，不只重复实现。

- core/mcp 代码改动：执行 `pnpm build`、`pnpm test`，工具契约或链路改动补充 `pnpm smoke`。
- Git/worktree 改动：执行 `pnpm verify:git`，检查分支复用、工作区绑定与变更摘要。
- 存储或并发改动：执行 `pnpm verify:twoproc`，检查 ID 唯一及写入不覆盖。
- bridge 改动：执行 `pnpm verify:bridge`，检查畸形消息及 Host/Origin 校验。
- UI 改动：执行 UI 类型检查与构建，使用内置 Chrome 工作流验证窄栏、宽视图、断连、任务流转及错误态。
- 纯文档改动：检查路径、链接、命令与实际实现一致，不必重复运行应用测试。

后台自动化测试设置最长 60 秒硬超时，超时终止对应测试进程并如实记录。集成验证使用临时数据目录及临时 Git 仓库，不操作用户真实看板或工作区。浏览器独立模式验收与 Codex 原生侧栏验收分别记录；卡片执行态和 `sessionId` 不证明真实 Agent 已启动，宿主声明也不证明接入已完成。

## Execution Plans & Histories

长周期任务和已完成的仓库改动必须记录在仓库中，不能只保留在聊天记录里。

- **执行计划**（`docs/exec-plans/`）：跨会话、存在架构风险或需要分阶段验证的任务必须创建计划。进行中的计划放在 `active/`，完成后移至 `completed/`，从 [执行计划模板](docs/exec-plans/templates/execution-plan.md) 开始填写，并将明确推迟的债务记录到 [技术债追踪](docs/exec-plans/tech-debt-tracker.md)。完整规范见 [PLANS_GUIDE.md](docs/PLANS_GUIDE.md)。
- **历史记录**（`docs/histories/`）：实际修改仓库的任务应按 `YYYY-MM/YYYYMMDD-HHmm-task-slug.md` 命名。使用 [历史记录模板](docs/histories/template.md)，如实填写 Git 用户，并通过 `git diff --shortstat` 与 `git diff --numstat` 记录本次任务的变更统计。完整规范见 [HISTORY_GUIDE.md](docs/HISTORY_GUIDE.md)。
- 纯问答或调研无需历史记录；仅新增或更新调研、评估、报告、执行计划及其模板，也不要求额外生成历史记录。

## 配置与协作注意事项

默认数据目录为 `~/.tasklane`。`TASKLANE_HOME` 控制数据目录，`TASKLANE_REPO` 与 `TASKLANE_BASE_BRANCH` 配置 Git 上下文，`TASKLANE_GIT=off` 关闭 Git 能力；已有看板的仓库配置以存储为准，修改环境变量不会迁移已有看板。bridge 使用 `PORT`、可选的 `TASKLANE_TOKEN` 与 `TASKLANE_ALLOWED_ORIGINS`。测试配置只对本次命令生效，不修改全局环境或 Git 配置。不得提交凭证、令牌、真实任务数据或敏感日志；本地共享 token 不等同于用户身份或工具级授权。

修改前检查 `git status` 并读取最新内容，保留他人的未提交改动。独立任务通过 `collab` 并行分配，明确输入、交付物与文件负责人；同一文件只由一个负责人写入，依赖模型或契约的整合验证串行执行。关键决定、验证结果和未完成事项必须留档。

未经用户明确要求，不执行 `git add`、`git commit` 或 `git push`。提交由用户发起；要求提交时先检查任务差异，排除已有设计资产和其他任务改动，提交信息参考近期 Git 历史。删除文件或工作区、批量修改、修改系统配置、破坏性数据操作、调用生产 API 或全局安装等高风险操作，执行前取得明确确认。

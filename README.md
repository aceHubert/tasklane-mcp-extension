# TaskLane

TaskLane（tasklane）— 编码 agent 侧边栏中的 MCP-native 任务看板。核心理念：**人和编码 agent 通过同一套 MCP contract 操作同一份任务数据**，UI 与 Agent 不各自维护状态。一个实例可管理多个本地 Git 仓库，每个仓库一个看板，任务归属隔离。

## 安装 Codex 插件

仓库托管在 GitHub（[aceHubert/tasklane-mcp-extension](https://github.com/aceHubert/tasklane-mcp-extension)），`plugins/tasklane/` 是构建产出的自包含插件包：内置 MCP 服务（`server.mjs`）、原生看板面板（单文件 UI）、图标及 `open-tasklane`、`native-execution` 技能。通过 Codex 插件 marketplace 安装：

```bash
# 添加本仓库为插件市场（也支持完整 Git URL 或本地路径 ./）
codex plugin marketplace add aceHubert/tasklane-mcp-extension

# 安装插件（插件名@市场名，定义见 .claude-plugin/marketplace.json）
codex plugin add tasklane@tasklane
```

安装后在 Codex 会话中即可使用：

- **项目会话**：说“通过 MCP 打开当前项目的 TaskLane 看板”，Agent 调用 `open_tasklane({ projectDir: "/path/to/current-workspace" })`；`projectDir` 必须是当前工作区绝对路径。
- **全局看板**：调用 `open_tasklane({})`。
- 已执行 `git init`、尚无提交的仓库也可打开看板、创建编辑任务及人工流转；基线必须与当前待首次提交的分支一致（默认 `main`，若使用 `git init -b master`，需传 `baseBranch: "master"`）。
- 非 Git 目录同样可添加为项目看板（`board_create` 按真实路径去重）：任务在该目录执行、续接与验收；Git 分支管理与创建 worktree 不可用（后续初始化 Git 后自动获得能力）。
- 路径无效或基线无效时工具会明确报错；不会将全局看板或浏览器页面当作项目打开成功。

宿主接入与验收细节见 `extension/README.md`。

### 更新插件

```bash
codex plugin marketplace upgrade tasklane   # 拉取市场与插件最新版本
codex plugin add tasklane@tasklane          # 更新现有插件
```

更新后需关闭并重新打开面板，并在新会话中确认工具版本——旧会话可能继续使用旧 MCP 服务，不要仅凭磁盘版本判断已切换。升级访问真实数据前需停用同一数据目录的旧写进程；旧 v1–v4 数据会在文件锁内备份 `.vN.bak` 后升级 v6（v5 备份 `.v5.bak`），不支持新旧服务混用。

## 快速开始（源码开发）

```bash
pnpm install
pnpm build         # tsc -b（workspace 引用，先 core 后 mcp）
pnpm test              # 单测（core 规则 + 存储并发/迁移 + 多看板归属 + tool 契约）
pnpm smoke         # stdio JSON-RPC 全链路冒烟（initialize→tools→board_create→create/assign/move）
node scripts/git-verify.mjs        # 真实 git 集成验证（多仓库隔离/注册去重/并发指派/分支复用）
pnpm verify:twoproc  # 双 MCP 进程共用存储：ID 不撞号、写入不互相覆盖、并发注册不重复
pnpm verify:bridge   # bridge 安全面：畸形 JSON-RPC 不崩溃、恶意 Origin/Host 拒绝
pnpm build:plugin    # 构建自包含 Codex 插件（server + widget HTML → plugins/tasklane/）
pnpm verify:plugin   # 插件冒烟：19 tools（17 业务 + open_tasklane + 只读宿主信息）、项目/全局模式、widget 资源
```

`pnpm build:plugin` 产出的 `plugins/tasklane/` 即上文安装的插件包，不要手改 bundle；本地调试可直接把仓库根目录作为 marketplace 添加（`codex plugin marketplace add ./`）。仓库结构、架构与开发规范见 `AGENTS.md`。

## 运行 MCP Server

```bash
# 默认存储 ~/.tasklane/board.json
pnpm mcp

# 自定义存储目录 / 绑定仓库 / 关闭 git 能力
TASKLANE_HOME=~/.tasklane \
TASKLANE_REPO=/path/to/your-repo \
TASKLANE_BASE_BRANCH=main \
node mcp/dist/src/index.js
```

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `TASKLANE_HOME` | 数据目录（board.json 落盘位置） | `~/.tasklane` |
| `TASKLANE_REPO` | 初始看板仓库路径；指派不创建工作区 | 空（git 降级关闭） |
| `TASKLANE_BASE_BRANCH` | task branch 的基线分支 | `main` |
| `TASKLANE_GIT` | 设为 `off` 强制关闭 git 能力 | on |
| `TASKLANE_BOARD_NAME` | 默认看板名称 | `Default Board` |

接入 Codex 宿主见 `extension/README.md`。

`pnpm mcp` 启动的是普通 stdio 业务服务，只注册看板和任务工具，不注册
`open_tasklane` 或 UI 资源。原生面板应使用上述插件中的 `server.mjs`。

## 显式使用浏览器（独立开发模式）

仅在明确要求浏览器方式或开发验证时采用此路径；会话中普通的“打开看板”请求
默认调用 `open_tasklane`，工具失败时报告原因，不自动启动 bridge 或打开 URL。

```bash
pnpm sidebar          # 构建 UI + 启动 bridge → http://127.0.0.1:7433
```

bridge 将 MCP server 以 stdio 子进程拉起，浏览器 UI 通过 WebSocket（`/mcp`）调用同一组 tools；
宿主嵌入后由宿主的 MCP Apps bridge 取代，UI 代码不变。

| 环境变量（bridge 透传） | 作用 | 默认 |
|---|---|---|
| `PORT` | bridge 监听端口（仅 127.0.0.1） | `7433` |
| `TASKLANE_TOKEN` | 设置后 WebSocket 升级必须带匹配的 `?token=`（UI 会先取 `/api/config` 自动附带） | 空（关闭） |
| `TASKLANE_ALLOWED_ORIGINS` | 额外允许的 WebSocket Origin（逗号分隔），供非代理的本机前端接入 | 空 |
| 其余同上表 | 透传给 MCP server | — |

bridge 安全面：只接受回环 `Host`（防 DNS rebinding）与同源 `Origin` 的 WebSocket 升级；
`null`/数组等非法 JSON-RPC 消息返回错误响应而非崩溃（`pnpm verify:bridge` 覆盖含 token 模式的全部场景）。

### 开发模式（Vite dev server + bridge 代理）

```bash
pnpm mcp &                                  # 或任意方式启动 MCP server（可选）
pnpm sidebar &                              # bridge（7433）
pnpm dev -w @tasklane/ui                # Vite dev（5176），/api 与 /mcp 已代理到 bridge
```

Vite 代理已配置 `changeOrigin` + Origin 重写，开发流量以 bridge 自身的回环 Host/Origin 到达，
无需额外配置 `TASKLANE_ALLOWED_ORIGINS`；代理目标可用 `TASKLANE_BRIDGE_HOST/PORT` 覆盖。

## MCP 工具契约

22 个业务工具的 schema 见 `mcp/src/register.ts`；插件另注册原生应用入口 `open_tasklane`
和只读宿主身份查询 `tasklane_host_info`：

| 工具 | 输入 | 行为要点 |
|---|---|---|
| `board_list` | — | 返回看板（含各自各状态计数与任务总数；counts/total 仅统计未归档任务，归档数量单独以 `archivedCount` 返回） |
| `dir_list` | `path?` | 列出目录子项并标记 Git 仓库与基线分支：优先 main、其次 master、无提交时取当前分支，其余默认 main（添加仓库表单的文件夹选择器） |
| `model_list` | — | 只读查询当前 Codex 宿主可用模型目录（经 `codex app-server` 的 `model/list`，与宿主选择器同源），返回 `models`（id/displayName/isDefault/supportedReasoningEfforts）与 `defaultModelId`；UI 单一模型下拉（不允许手输）的候选数据源，默认继承宿主，获取失败仅保留继承宿主默认，不属于执行链路 |
| `board_create` | `repo, name?, baseBranch?(默认main，仅 Git 项目)` | 注册本地项目目录为新看板；Git 仓库校验工作区/根目录/基线分支，非 Git 目录按真实路径注册（同仓库或同目录幂等返回已有看板） |
| `task_list` | `boardId?, status?/assignee?/priority?, archive?(默认active)` | 过滤任务列表；`archive: active/archived/all` 控制归档范围，默认只返回未归档；单看板可省略 boardId，多看板必须指定。排序：未完成任务按 deadline 升序排前（无 deadline 靠后，组内按 ID 序），done 保持 ID 序排最后 |
| `task_get` | `id, boardId?` | 任务详情 + 最近 12 条执行时间线；传入 boardId 时校验归属 |
| `task_create` | `title, boardId?, description?, priority?(默认P2), status?(默认backlog), deadline?` | ID 全局递增 TASK-1xx，任务归属指定看板；`deadline` 为可选截止时间（严格日历校验，`2026-02-30` 等不存在的日期拒绝；无时区标记按 UTC 解析，服务端规范化为 UTC ISO） |
| `task_update` | `action(必填: update/assign/review), id, boardId?, title?, description?, priority?, deadline?, execution?, assignee?, expectedRevision?, status?, conclusion?, actor?` | 复合入口按 action 分发：`update` 编辑基础字段（`deadline` 传字符串为设置、传 `null` 为清除、不传不动；无关联 execution 写入返回 EXECUTION_REPORT_REQUIRED）；`assign` 仅指派负责人；`review` 为验收状态 CAS 更新（详见 [原生执行契约](docs/native-execution-contract.md)） |
| `task_delete` | `id, boardId?` | 硬删除单个任务及执行时间线（不可恢复，级联清理会话记录）；仅允许 backlog 且未进入执行链的任务，非 backlog 拒绝；已完成请用归档 |
| `task_move` | `id, status, boardId?` | 只改业务阶段；review 读取已有工作区的 diff 摘要，不改变执行态 |
| `task_update`（action=assign） | `action, id, assignee, boardId?` | 复合工具的指派分支：仅改变负责人元数据，不生成 session，不创建工作区，不启停执行 |
| `task_archive` | `id, boardId?` | 归档单个 done 任务（幂等）；归档后从日常看板与计数移出，内容、时间线与 Git 绑定保留 |
| `task_restore` | `id, boardId?` | 恢复归档任务到 Done（幂等）；移除 archivedAt，其余字段不变 |
| `task_archive_done` | `boardId`（必填） | 原子归档当前看板全部未归档 done 任务；目标在锁内按最新状态选取，失败无部分写入 |
| `task_export` | `boardId?, start?, end?, scope?(默认all含归档), path?, lang?(默认zh)` | 按时间区间导出看板任务为 Markdown 报告并落盘（只读，不改任务与存储）。区间缺省「今天往前一个月」（本地自然日含边界）；命中口径为创建/更新/归档时间任一落在区间内；默认写入数据目录 `exports/`，文件名含区间日期与生成时刻避免冲突，`path` 可指定绝对路径；返回 `path/bytes/range/scope/stats/markdown`。对应 UI 设置菜单的「导出报告」 |
| `task_execution`（action=external_bind） | `action, id, boardId, provider, sessionId, workspacePath, workspaceOwner, branch?, force?` | 复合执行工具的外部会话分支，记录非 Codex Agent 的实现会话：`sessionId` 保持 provider-local opaque 语义（不解释为 Codex threadId、不产生深链、不推断 running）；Git 看板校验仓库身份，非 Git 项目须等于项目目录，无项目任务拒绝；替换不同已有会话须显式 `force` 且无在途执行。Review 解析待验收工作区的来源之一 |
| `task_update`（action=review） | `action, id, boardId, expectedRevision, status, conclusion?, actor?` | 复合工具的验收分支，更新 Review 工作流状态（仅 review 列，revision/CAS 防跨 Agent 覆盖）：`changes_requested/approved` 须非空结论并关闭当前轮；`reviewing/fixing` 不得绕过真实 running 回执；`recheck_pending` 由实现方完成后提交。approved 不自动移动 Done |

多看板省略规则：列表/创建省略 `boardId` 仅在只有一个看板时自动解析；按任务 ID 的
读取/修改省略时用任务自身归属，传入错误归属返回 `BOARD_MISMATCH`，不存在的看板返回
`BOARD_NOT_FOUND`。旧 v1–v4 数据在文件锁内完整校验、备份 `.vN.bak` 后升级；
v5 数据备份 `.v5.bak` 后补全请求 `purpose=implementation`；v6 数据备份 `.v6.bak` 后
为看板回填项目目录身份（`projectDir`），归档冷文件同批升级 v3（读取兼容 v1/v2）。
升级前需停用同一数据目录的旧写进程；任务、归档、时间线、序号和 Git 绑定保留。

v7 的 `board.json` 仅保存活跃任务及其时间线、看板配置（含项目目录与 Git 能力身份）、
序号与归档计数。无项目看板（default 未绑定仓库）的执行请求 `repo` 为 null、绑定不记录
工作区；非 Git 项目看板按 `projectDir` 锚定目录。
归档任务和时间线保存于同一数据目录的 `archive/<boardId>.json`（v3，读取兼容 v1/v2），首次归档时创建。
日常列表、看板计数和活跃任务读写不读取冷文件；归档视图、详情、恢复和导出按需读取。
备份数据时应同时保留 `board.json` 与整个 `archive/` 目录。

归档先写冷文件再移除热数据，恢复先写热数据再移除冷数据，使用同一全局文件锁。
中断最多留下重复副本，读取以热文件为准，重试可安全收敛。迁移中断后可重新启动完成迁移。
若需回滚到 v5，应先停止所有写进程，另行备份升级后的 `board.json` 与整个 `archive/`
（v6 可能已把冷文件重写为 v2），再用 `board.json.v5.bak` 恢复主文件并恢复归档备份；
升级后的 Review 记录不会包含在旧备份中。旧版本无法读取 v6/v2，不能只回退程序而保留新主文件。

### 状态流转规则

```
backlog → ready → doing → review → done
   ↖_______________________↩            （均允许一步回退：review→doing、done→review 等）
```

前向流转允许跳步进入 doing；跨过 review 直接 done 会被拒绝（`INVALID_TRANSITION`）。

原生执行闭环（`task_execution` 复合工具 + purpose 分流）与宿主能力门控属于实现细节，
设计决策见 `AGENTS.md`，完整参数与状态机见[原生执行契约](docs/native-execution-contract.md)。

### Review 工作流

实现与验收是两个分离的执行上下文：`executionBinding` 只表示 Codex 中执行任务实现的
真实绑定；`reviewBinding` 表示独立的 Review / Recheck 会话（不同聊天、同一实现工作区）。
`Task.review` 保存 `pending → reviewing → changes_requested → fixing → recheck_pending →
reviewing → approved` 的多轮验收状态与每轮结论，返工期间任务保留在 Review 列。
Review 启动强制解析唯一实现工作区（无来源 `REVIEW_WORKSPACE_REQUIRED`，多来源冲突
`REVIEW_WORKSPACE_CONFLICT`，`board.repo` 不能作为猜测来源），验收会话不另建 worktree。
首次验收可选模型，复查复用原会话与模型；跨 Agent 更新使用 revision/CAS（过期
`REVIEW_STALE`）。approved 不自动移动 Done，UI 在通过后才开放「标记完成」；
继续修改 / 复查的业务提示词可在发送前编辑，系统协议封装（身份、绑定、工作区与回执要求）不可编辑。

已连接且识别为 Codex 的面板可直接选择工作方式并提交任务，不另建验证聊天。
新任务默认人工；Run Codex 的有效执行请求持久化后自动标记为 Agent，不再提供独立的手动指派按钮。
标识表示执行意图，不证明已经运行。创建发起后由执行会话自行核验真实会话并完成绑定，绑定、执行与回执都通过 MCP 直接写入看板；投递成功、明确拒绝和结果未知分别显示，
开始和完成以目标聊天回执为准。

## 许可证

本仓库以 [MIT License](https://opensource.org/licenses/MIT) 发布，与插件清单
（`plugins/tasklane/plugin.json`）中声明的 `license: MIT` 一致，作者为
[aceHubert](https://github.com/aceHubert)。

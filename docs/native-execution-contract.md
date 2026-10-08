# Codex 原生执行桥契约

本契约只编排用户明确请求的原生宿主操作，不提供执行器、身份认证或实时进程监控。
MCP Apps 的消息接口只能发往面板关联聊天；跨聊天操作必须由接收 Agent 调用实际可用的原生工具。

## 握手与实际任务

- 成功的 MCP Apps 握手提供实际 `hostInfo`；`open_tasklane` 返回的 `mcpClient: { name, version }`
  来自服务端 SDK 的真实 MCP 客户端信息。UI 可结合成功握手与 Codex MCP 客户端名称识别环境，
  兼容宿主通用桥接名称。识别后使用 Codex 文案，其他或未知环境使用 Agent 文案。
  这些字段只是身份提示，不构成认证或执行能力证明，也不从任务文本和调用参数伪造客户端身份。
- 当前握手已连接、实时识别为 Codex、提供 `message.text` 且看板范围有效，即允许提交
  用户明确要求的实际任务。原生创建、目标消息和工作区支持在这个请求中核对，
  不再要求 `nativeExecution`、10 分钟能力租期或独立验证聊天。
- 刷新后调用只读 `tasklane_host_info` 取得当前 MCP 客户端。`window.name` 仅恢复看板范围，
  不缓存宿主身份或权限；断连、未知身份、项目错误范围仍禁用且没有任务写入。
- SDK 通道存在表示可以尝试投递，不证明原生工具可执行。接收 Agent 在实际请求中
  检查当前工具签名、目标项目与工作区，不支持则明确报错，不使用其它执行器兜底。
- 发送前不伪造 hostId/receiverThreadId：接收 Agent 认领时核对自身真实宿主与线程，
  保存为 `request.receiver`。全局面板同样固定用户选中的看板及仓库。
- 新任务聊天的初始提示词只分发任务 ID 与 MCP 执行要求。目标自行 task_get 读取步骤、真实身份、
  工作区与本轮 requestId/runId/claimId，先保存 `phase=created` 再以同一结果保存 `phase=bound`，绑定后直接执行读取的任务步骤。
  `threadId` 才是可打开的真实会话标识；内部 sess-* 和创建中的 clientThreadId 不能代替。
- 中间会话认领后仅创建一次，把任务 ID 与执行要求分发后即结束：不等待创建结果、不调用 wait_threads/read_thread 获取目标身份、不保存绑定、不移动看板列。clientThreadId 是异步创建的正常返回，不得当作真实会话标识或写入绑定，也不重建。
- 绑定、移列与执行回执全部由目标通过 MCP 工具自行完成；MCP 工具对所有会话通用，不依赖会话间通讯。Ready 到 Doing 的移列由核心在首个有效 running 回执时同一事务完成；已在 Doing/Review/Done 不回退。消息投递与绑定均不证明实际运行，running/completed 由目标直接回写 MCP。
- 目标可用 CODEX_THREAD_ID 作为查询线索，但必须 read_thread 核验自身身份和 cwd，不使用 source_thread_id 冒充自身。detached HEAD 的 branch 为实测 HEAD，提交 SHA 不传入 branch。
- 非 Codex 或未握手时，执行、回复、继续和重试均禁用且无写入副作用。
  停止始终禁用，直到存在单独验证的可靠中断接口。

## 结果与异常

### 主动核对会话状态

详情的“核对会话状态”入口仅在当前请求为 pending/delivered/claimed/created/bound、
距 updatedAt 严格超过 5 分钟且任务未归档时显示；blocked/uncertain、运行、等待及终态
使用各自状态提示和已有操作。显示后的入口仍受 MCP 连接、Codex 身份、消息能力和看板范围守卫。
底层 purpose=status 的关联核对能力覆盖启动、运行、等待、阻塞及终态请求，归档或 cancelled
不可核对。它不继续正文、不创建聊天、不重置任务，也不解除等待。
0.3.19 起核对消息由 UI 经 SDK 直接发送，不再通过 MCP 工具登记 checkId/purpose。接收 Agent 读取真实会话后，目标若可能漏回执，可在仅核对消息中核实工作后补 task_execution action=report 回执。终态不可回退，idle 不是完成证明；最后 task_get 确认回写。死会话的等待解除是用户专属操作：面板「解除等待」按钮（app-only 工具 task_execution_recover）在用户显式确认旧会话已结束后取消等待中的请求并复位执行状态，模型侧不可调用；重复解除幂等，非等待态拒绝。
purpose=status 禁止 stopped；默认 recovery 兼容旧等待恢复路径，仍须原有快照和完整宿主观测。相同用途的 60 秒内 pending 检查合并，不同用途不互相覆盖。新 purpose 与状态检查观察字段需新插件整体加载。

- 消息发送成功：记录 delivered，提示已投递、等待真实开始回执。
- 所有明确的任务分发失败均记录 rejected 和错误摘要，覆盖宿主路由、聊天创建、准备或
  绑定、start/reply/continue/retry 的消息投递，不按具体异常名称限定。
  本轮没有 startedAt 或任何目标回执时，原认领者携匹配 claimId 结束失败分发；
  请求保留 result 和原绑定，执行恢复 assigned/idle，用户可以再次发起。
  未认领的面板请求同样可结束未分发失败；继承结果的恢复请求须具备合法 recoveryOf。
  这不是已运行任务的 failed 回执；用户可以显式提交新尝试，不能自动换模型或工作方式。
- 超时、传输异常或创建结果未知：记录 uncertain，核对原操作，不自动重发或重复创建。
- 原生工具结果就绪后立即保存真实结果；已有映射必须复用，未知结果禁止再次创建。
- 真正开始和完成：目标聊天核对自身绑定后报告 running/completed，不由发送者代报。

非 Codex 或身份未知时默认不执行，不提供 CLI、App Server、后台执行器或私有注入兜底。

## 无项目执行与看板类型

看板分三类，身份与能力分别表达，不互相伪造：

- **无项目看板**（default，`repo` 与 `projectDir` 均为空）：任务执行使用
  `workspaceMode=projectless`。原生创建使用 `create_thread(target:{type:'projectless'})`，
  不传 projectId、不创建项目或 worktree。绑定（created→bound）只保存真实
  threadId/hostId，不记录 workspacePath/workspaceOwner/branch；不把当前聊天目录、
  看板数据目录或其他项目当作默认执行目录。无项目任务不参与 Review 流转。
  `project`/`worktree` 模式在无项目看板被拒绝。
- **非 Git 项目看板**（`projectDir` 为真实目录、`repoKey` 为空）：任务在项目目录
  执行（`workspaceMode=project`，request.repo 锚定 projectDir），绑定 workspacePath
  等于项目目录、owner=user、不带 branch。原生创建需宿主项目身份匹配该项目目录；
  宿主未登记时明确报告接入条件，不猜测 projectId、不要求初始化 Git。
  `worktree` 请求被 Core/MCP 拒绝（拒绝不创建目录、分支或聊天）；
  Git 分支管理与 Git diff 能力不可用。
- **Git 项目看板**（`repoKey` 非空）：维持原 project/worktree/existing 语义。

Git 能力按目录当前实际状态动态检测，不固定为添加时的分类：`board_list`
节流触发能力刷新，目录初始化 Git 后自动采纳仓库身份（保留 boardId、任务、
会话绑定与项目目录，无需重新添加），Git 被移除后撤销能力；与其他看板身份
冲突时记录 `board.repoConflict` 显式提示，不自动合并看板或迁移任务；探测
失败（目录丢失、Git 损坏）同样记录冲突说明，不静默撤销。展示口径来自最近
一次刷新，执行 Git 分支或 worktree 操作前仍以服务端只读核验为准。

## 执行目的（implementation / review）

每个执行请求携带 `purpose`（省略按 `implementation`），决定回执写入哪份执行状态与绑定：

```text
implementation → execution / executionBinding（任务实现，现有语义不变）
review         → reviewExecution / reviewBinding（独立验收会话）
```

- `review` 请求仅支持 `action: start`（首次验收）与 `action: continue`（复查），
  `workspaceMode` 必须为 `existing`；服务端解析实现工作区并把绝对路径锁定到
  `request.workspacePath`（调用者不能指定）。`model` 仅 start 可选，复查禁止传模型。
- 无项目看板（无 repo 且无 projectDir）的任务不参与 Review 流转：
  `purpose=review` 请求与外部会话工作区记录均被拒绝，UI 不提供验收入口。
- 首次验收要求 `Task.status = review`、`review.status = pending` 且尚无 `reviewBinding`；
  当前首次分发已 rejected 且保存真实 result 时，允许 start 重新发起并复用结果，
  已有 reviewBinding 也不重复创建。复查要求 `review.status = recheck_pending`，
  复用 reviewBinding 或本轮失败分发已保存的真实结果。
- 实现工作区来源（多个互不相同的来源视为冲突）：`executionBinding.workspacePath` →
  `externalExecutionSession.workspacePath` → `task.worktreePath`。`board.repo` 只用于
  仓库身份校验，不能作为工作区猜测来源。无来源返回 `REVIEW_WORKSPACE_REQUIRED`，
  多来源冲突或复查时实现上下文漂移返回 `REVIEW_WORKSPACE_CONFLICT`。
  核验按看板类型分流：Git 项目校验仓库身份与分支/worktree；非 Git 项目要求
  待验收目录等于 `board.projectDir` 且存在、可访问，不调用必须依赖 Git 的校验，
  也不伪造 Git diff 或分支信息。
- Review 绑定复用同一套 created → bound 协议，但额外校验：
  `workspacePath` 必须等于解析出的实现工作区（不另建 worktree），
  且 `threadId + hostId` 不得与 `executionBinding` 相同（实现与验收必须是不同 Codex 会话）。
- 回执按请求持久化的 purpose 分流：review 请求的 running/waiting/blocked/failed/completed
  只写 `reviewExecution`，不触碰实现执行状态；`task_execution`（claim/delivery/bind/report 分支）
  无需调用者再次声明 purpose。
- review 的首次 running 回执在 `pending / recheck_pending` 时开新一轮验收轮并置
  `reviewing`；重复 running 回执不重复开轮。review 的 completed 只是会话执行完成，
  不等于 approved，也不移动看板列。
- Review 列内继续实现（purpose=implementation 的 running 回执且 review 处于
  `changes_requested`）把 Review 状态推进到 `fixing`；任务保留在 review 列，返工不移动列。
- 当前 `reviewExecution.state` 或其对应的验收请求为 `blocked` 时，禁止发起和认领
  实现执行请求（包括 start/reply/continue/retry 及同请求重放），返回 `EXECUTION_CONFLICT`，
  不改变负责人、执行代次或时间线。应先恢复验收、形成结论并结束本轮验收执行；
  仅提交 `changes_requested` 或 `recheck_pending` 不会绕过此守卫。
  已结束的历史验收请求或历史 blocked 回执不阻止当前正常的继续修改。

## Review 工作流与跨 Agent 更新

`Task.review` 保存结构化验收状态，与 `Task.status` 业务列分离：

```text
pending → reviewing → changes_requested → fixing → recheck_pending → reviewing → approved
```

- 每次真实验收 running 开一轮 `ReviewRound`（编号、工作区、结论、起止时间与更新记录），
  新一轮不覆盖旧轮结论；`revision` 随每次状态变化（含系统转换）递增。
- `task_update action=review` 使用 `expectedRevision` CAS：过期返回 `REVIEW_STALE`，
  调用方必须 `task_get` 后基于最新状态重试，不得静默覆盖他人结论。
  `changes_requested / approved` 必须携带非空 `conclusion`；`reviewing / fixing`
  不得绕过真实 running 回执（无 startedAt 时拒绝）；仅 review 列可更新。
- `approved` 不自动移动 Done；UI 的「标记完成」在 `review.status = approved` 后才开放，
  显式业务流转仍由 `task_move` 完成。
- 更新者审计信息（`actor: { type, provider?, sessionId? }`）是元数据，
  不是执行绑定，也不得被当作 Codex thread。

## 非 Codex 实现会话（externalExecutionSession）

`task_execution action=external_bind` 记录非 Codex Agent 的实现会话：

- `provider`（禁止 `codex-desktop`，Codex 会话必须走原生绑定）与 provider 本地
  opaque `sessionId`（不套用 Codex thread 规则，允许任意非空标识）。
- `workspacePath` 必须是任务看板项目的真实工作区：Git 看板做仓库身份校验；
  非 Git 项目看板要求等于 `board.projectDir` 且目录存在、可访问，不记录 branch。
  无项目看板任务不记录工作区，该工具对无项目任务拒绝。`workspaceOwner`
  为 `user / tasklane / agent`；Git 看板可选 `branch` 提供时与工作区核验一致。
- 记录不写 `threadId`、不产生 `codex://` 深链、不推断 running、不改执行状态或负责人。
- 替换不同已有会话必须显式 `force: true`，且存在待确认或运行中请求时仍拒绝；
  相同内容重复记录幂等刷新。该记录是 Review 工作区解析的来源之一，
  是否能自动 Resume 由对应 provider adapter 决定，不由该字段推断。

## 模型（存储 v6）

### 可恢复阻塞 blocked

- blocked 是执行状态和请求状态，不是任务业务阶段，也不表示已停止真实进程。
- 绑定前由原认领者通过 delivery blocked 写入非空原因，保留 claim、run 和已有 result；绑定后的目标通过 report blocked 写入非空 activity，不要求先伪造 running。
- 获得真实 threadId/hostId/workspacePath 后先保存 created；后续异常不得删除结果。UI 可展示/打开经过保存的真实 result，不必等到 bound。
- 用户点击“核对后继续”产生新 run，必须已有真实 binding 或当前 blocked 请求的 result；继承同一结果和 recoveryOf，不允许更换工作区、模型或创建聊天。先核对原阻塞原因、宿主聊天状态及工作区，解除后再运行，否则继续报告 blocked。
- 无真实结果时继续执行被拒绝，先核对原创建或提供真实聊天链接；仅有 clientThreadId 不得冒充真实会话。blocked 下重复 start/retry 不创建新请求。
- 旧 run 的回执失效，迟到的投递/阻塞回执不得覆盖已绑定运行或终态。普通等待输入 waiting 与真正结束失败 failed 仍保留。
- 写入后必须 task_get 核对状态与原因，不能仅凭工具响应无错误就声称更新成功。
- v4 新增枚举需要新旧读写服务同时升级；不混用不认识 blocked 的旧进程，回滚不能丢弃已保存聊天或阻塞记录。

`execution.sessionId` 仅保留旧内部标识，不创建新的 `sess-*`，不转换成真实线程。
`execution.runId` 指向当前请求的运行代次。普通指派和手动业务流转不启动/结束真实执行。

新任务默认 `assignee: human`。UI 不再提供独立指派按钮或创建后自动指派；Run Codex/继续执行的新有效请求在同一存储事务中持久化请求、设置 `assignee: agent` 和 `execution.state: starting`。
这个标识表示用户已请求 Agent 处理，不是运行证明。参数错误、归档、错误看板或执行忙时不更改标识；幂等重放不覆盖后续修改。
已记录请求的明确拒绝、结果未知、失败或完成不自动切回 human，异常由请求/执行状态独立表达。保留 MCP `task_update action=assign` 供既有调用者显式管理元数据，不提供其 UI 入口。

`executionBinding`：

- `provider: 'codex-desktop'`
- `threadId`、`hostId`：原生工具返回的就绪标识；拒绝 `sess-*` 和创建中占位标识。
- `workspacePath` / `workspaceOwner`：实际执行目录与归属；projectless 结果两者
  成对缺省（无项目任务不记录工作区），其余模式必须成对提供且路径为绝对路径。
- `branch?`、`boundAt`：实际分支和服务端绑定时间（projectless 不携带分支）。

`reviewBinding` 结构与 `executionBinding` 一致，但语义独立（Review / Recheck 的 Codex 会话）；
`reviewExecution` 是与 `execution` 分离的验收执行状态（各自持有 runId）。
同一 `threadId + hostId` 不得同时充当实现与验收绑定。

`executionRequests` 持久保存每次请求及其关联结果，包含 `requestId`、服务端 `runId`、
`taskId`、`boardId`、`purpose`（implementation / review，v6 起必填）、`action`、`workspaceMode`
（v7 起 project/worktree/existing/projectless）、可选的不可变 hostId/receiverThreadId 路由提示、
认领时的实际 `receiver: { hostId, threadId }`、`repo`（Git 仓库根或项目目录；projectless
请求为 null）、review 请求的 `workspacePath?`（服务端解析的实现工作区）、
`message?`、`model?`、`status`、`requestedAt`、`updatedAt`、`claimId?`、`result?`、`startedAt?`、
`reports?`、`deliveryError?`。保留完整回复，不用活动摘要代替。

请求状态包括 `pending / delivered / claimed / created / bound / running / waiting / blocked / completed / failed / uncertain / rejected / cancelled`。
等待传输或创建时 `execution.state` 为 `starting`，投递/创建/绑定都不写 `running`。

## MCP 工具

以下工具的 `boardId` 均必填，事务内重查归属和归档守卫。标识符均为非空、长度不超过 200 的字符串。

0.3.19 起执行链收敛为单工具按 `action` 分发（原六个工具的参数与守卫不变，分支必填在
handler 层校验）；`task_review_update` 并入 `task_update action=review`。宿主对每个
MCP 服务只向模型公布按名称排序的前 20 个工具，收敛后的模型可见工具数为 11。

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `task_execution`（action=request） | `action, id, boardId, requestId, requestAction: start/reply/continue/retry, workspaceMode: project/worktree/existing/projectless, purpose?: implementation/review, hostId?, receiverThreadId?, message?, model?` | `{ task, request, created }` |
| `task_execution`（action=delivery） | `action, id, boardId, requestId, runId, status: delivered/uncertain/rejected/blocked, error?, claimId?` | `{ task, request }` |
| `task_execution`（action=claim） | `action, id, boardId, requestId, runId, claimId, hostId?, receiverThreadId?` | `{ task, request, claimed }` |
| `task_execution`（action=bind） | `action, id, boardId, requestId, runId, claimId, phase: created/bound, threadId, hostId, workspacePath?, workspaceOwner?, branch?`（projectless 三者全部省略；其余模式 workspacePath/workspaceOwner 必填成对） | `{ task, request }` |
| `task_execution`（action=report） | `action, id, boardId, requestId, runId, threadId, hostId, reportId, state: running/waiting/blocked/failed/completed, activity?` | `{ task, request }` |
| `task_execution`（action=external_bind） | `action, id, boardId, provider, sessionId, workspacePath, workspaceOwner: user/tasklane/agent, branch?, force?` | `{ task }` |
| `task_update`（action=review） | `action, id, boardId, expectedRevision, status: reviewing/changes_requested/fixing/recheck_pending/approved, conclusion?, actor?` | `{ task }` |
| `task_execution_recover`（app-only） | `action 无；id, boardId, requestId, runId, reason`（面板"解除等待"人工操作，模型不可见） | `{ task, request, changed }` |

- `start` 仅用于尚未绑定任务；已绑定时用 `continue/reply/retry`，复用原聊天与工作区。
- `model` 仅用于 `start`，省略时沿用宿主默认设置。指定值随请求持久化并参与幂等比较，
  接收 Agent 必须在调用 `create_thread` 时传入，不得静默替换；不可用时明确报告限制。
  面板在工作区选项下提供单一模型下拉，不允许手输：默认项为「继承宿主默认模型」，
  候选来自只读工具 `model_list`（经 `codex app-server` 的 `model/list` 与宿主选择器同源）；
  请求提交后锁定，已绑定时显示创建时的选择，不将请求中的模型视为实际运行模型证明。
  继续回复与重试不传模型覆盖；目录获取失败时仅保留继承宿主默认，不影响请求与执行链路。
- `reply` 需要非空完整 `message`；最大 20,000 字符。运行中拒绝并发启动另一轮。
- 同一 requestId 的完全相同请求返回原记录；参数不同则拒绝。同任务相同且尚未确认的请求合并，`created: false` 时 UI 不再次发消息。
- 新请求由服务端生成独立 runId；终态旧请求重放不启动新一轮，旧 runId 回执不能覆盖当前运行。
- `claim` 在文件锁内认领；初始未知路由时必须传成对的真实 hostId/receiverThreadId，
  与提供的原始提示和已有绑定宿主匹配，保存实际 receiver。同一认领不能替换 receiver，
  不同 claimId 拒绝，禁止超时自动抢占或再次创建聊天。
- `bind phase=created` 在调用原生创建工具后立即持久化真实结果；`phase=bound` 必须引用相同结果，允许故障后恢复。
  认领后结果未知时保留待确认，不再创建。恢复时先核对原生结果与已保存映射。
- 绑定目录由核心只读验证：必须属于看板仓库且为实际 Git 工作区根；主仓库模式不接受别的 worktree，独立模式不接受主仓库，旧 worktree 必须原样复用。
  不创建分支/worktree，不自动首次提交。旧 `repo/baseBranch/branch/worktreePath` 保留。
- 回执校验真实绑定、当前 requestId/runId、hostId/threadId；`reportId` 幂等，终态不回退。
  完成须已有真实开始回执；本轮首次有效 running 在同一事务中将当前 Ready 任务移到 Doing，原子写入 started 与 moved 时间线。
  创建、投递、绑定及 blocked 不移动看板列；同轮后续 running 不覆盖用户手动流转，Backlog/Review/Done 不自动移动。其它阶段仍用 `task_move` 合法推进。
- `task_update.execution` 不再接受无关联的执行状态写入，返回 `EXECUTION_REPORT_REQUIRED`。
  普通 `task_update action=assign` 只改负责人；`task_move` 只改业务状态及读取已有工作区的变更摘要。
- 面板无认领身份的迟到 delivery 不能覆盖已认领请求；原认领者的明确失败按下列规则结束准备。
  任何 delivery 都不能覆盖目标真实执行回执；超时为 `uncertain`，不能把未知结果记成失败或停止。
- 接收 Agent 认领后，任意动作在 claimed/created/bound/uncertain/blocked 分发准备阶段
  明确失败时，rejected 须匹配 claimId 且本轮没有 startedAt 和任何目标 reports；
  保存真实结果不证明任务已接手，因此创建、准备、绑定失败也可结束等待。
  不使用 delivery blocked 或伪造目标 failed/completed 来代替明确分发失败。
  rejected 保留结果、负责人和业务阶段，将实现执行复位 assigned/idle、验收执行复位 idle；
  当前 runId 保留以支持拒绝重放，新的用户请求才更换代次；已有 result 时新请求记录
  recoveryOf 并完整继承结果、工作方式和模型，先核验再复用，禁止重复创建聊天或工作区。
  原模型省略表示继承；显式更换模型、工作方式或宿主被拒绝。无创建结果的明确失败可重新创建。
  首次验收仍 pending 时，失败后 start 重新发起也只复用已知验收聊天，真实 running 才开轮。
  已有任意目标回执、错误 claimId 或面板的迟到拒绝均不能走此路径；未知结果继续等待。
  rejected 不写 running、failed 或 startedAt，错误须为非空且不超过 200 字符。
  存储严格校验同步允许准备阶段的 rejected+result 及恢复请求保留模型，检查 recoveryOf
  的原代次、purpose、结果、模式和模型一致。读写服务须一并升级，旧读取器不支持该组合。

错误码：`EXECUTION_BUSY`、`EXECUTION_CONFLICT`、`EXECUTION_STALE`、`EXECUTION_REPORT_REQUIRED`、
`REVIEW_WORKSPACE_REQUIRED`、`REVIEW_WORKSPACE_CONFLICT`、`REVIEW_STALE`，
以及现有 `VALIDATION / BOARD_MISMATCH / TASK_ARCHIVED / GIT_ERROR`。
这些关联校验不证明调用者身份；本地 MCP 通道的信任边界保持不变。

### 报告卡片（宿主会话内渲染）

插件模式（`extension/src/plugin-server.mjs`）向 `createServer` 传入 apps 选项，把
`task_execution` 的 report 分支绑定为报告卡片；独立模式（stdio 直连、脚本与测试默认）不传，
工具定义与结果保持原样（无 `_meta` 与 widget 字段）。

- 工具定义 `_meta` 对齐 `open_tasklane` 最小集：`ui.resourceUri`（含
  `visibility: ["model", "app"]`）、`openai/outputTemplate`、`openai/widgetAccessible` 与
  `openai/toolInvocation/invoking|invoked`；不挂 `openai/ui` entrypoints，不进入侧边栏入口。
- 成功回执在原 `{ task, request }` 结果上合并 widget 字段并重新序列化 text（与
  structuredContent 保持同源）：`{ version: 2, widget: 'tasklane-board', title: 'TaskLane',
  rendering: 'native-widget', mode: 'project', boardHome, lockedBoardId: task.boardId,
  repoRoot, projectDir, taskId: task.id, presentation: 'report-card',
  reportCard: { taskId, title, priority, state, activity?, updatedAt }, mcpClient? }`，
  同时附 `_meta.widgetData` 为同一合并对象。
  错误结果（校验失败、回执冲突）保持 `fail()` 原样，不渲染卡片。
- 字段来源（`extension/src/report-card.mjs`）：boardHome = 数据目录；repoRoot = 看板记录
  仓库绝对路径，缺仓库时回退看板项目目录、请求仓库、绑定工作区；projectDir 优先执行绑定
  `workspacePath`（保留 worktree 视角），回退 repoRoot；mcpClient 取实际握手客户端。
  任一路径无法解析为绝对路径时保持纯结果，不阻塞回执。`purpose=review` 的快照与
  工作区取 `reviewExecution/reviewBinding`，不误用实现执行状态。
- 报告使用独立资源 `ui://widget/tasklane/report-card-v0318.html`，声明
  `availableDisplayModes: ['inline', 'fullscreen']`、`preferredDisplayMode: 'inline'`。
  初始仅显示任务 ID、标题、优先级、回执状态、活动摘要与“查看详情”；收到回执不请求
  fullscreen、不自动打开详情，工具结果到达前也不显示其他项目看板。
- 用户点击卡片的“查看详情”才请求宿主切换 fullscreen；宿主确认且看板上下文仍有效后，
  使用锁定 `lockedBoardId` 与 `taskId` 打开现有详情。拒绝、不支持或范围变化时保持卡片
  并提示错误，不把业务回执失败或重新投递执行请求。普通 `open_tasklane` 入口仍用
  `board-panel-v0318.html` 完整看板。每次状态回执产生各自快照，不假设宿主能跨消息合并卡片。
- 执行协议语义零变化：report 校验、状态机、首个 running 自动 Ready→Doing、终态守卫与
  存储版本均不受影响；卡片只是回执结果的展示通道，不新增权限或执行入口。

## 迁移和验收边界

v1–v4 在文件锁内重读、完整校验、备份为 `.vN.bak` 后原子迁移；v5 → v6 在锁内为全部
旧请求补 `purpose: implementation`，备份 `.v5.bak`；v6 → v7 为已有 repo 的看板回填
`projectDir`（等于主仓库根），备份 `.v6.bak`，归档冷文件与主文件同批升级（v2 → v3；
读取兼容 v1/v2，按实现语义补 purpose）。v6 新增的 review / reviewExecution / reviewBinding /
externalExecutionSession 字段保持缺省：旧 review 列任务不自动假设已验收，读取侧按
`status = review` 惰性初始化为 pending（不落盘，首次真实流转时持久化）。
任务、请求、时间线、ID、序号、归档计数与 Git 绑定原样保留。v7 新增的 projectless
请求（repo 为 null）与缺省工作区结果只影响新写入，旧请求与绑定语义不变。

- 升级前须由用户停用同一数据目录的旧写进程；新旧服务禁止同时写同一数据目录。
- 回滚步骤：停掉 v7 写进程 → 用对应 `.bak` 恢复主文件并恢复整个 `archive/` 目录备份
  （v7 服务可能已把冷文件重写为 v3，旧服务无法读取）→ 接受升级后的记录不在旧备份中。
  不删除任何真实 Codex thread、外部 Agent session、branch 或 worktree。
- 归档任务同样完整读取新 Review / binding 字段（v3 冷文件）。

协议自动化测试和浏览器宿主模拟不证明当前 Codex Desktop 原生路由可用。
真实项目入口、全局入口、工作区复用和深链接验收须单独记录；能力缺失在实际任务中明确报错。

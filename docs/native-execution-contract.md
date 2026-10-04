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

详情的“核对会话状态”发送 purpose=status 的关联核对消息，覆盖当前启动、运行、等待、阻塞及终态请求，归档或 cancelled 不可核对。它不继续正文、不创建聊天、不重置任务，也不解除等待。
先通过 task_execution_recovery_request 持久 checkId/purpose，再由接收 Agent 读取真实会话；目标若可能漏回执，可在仅核对消息中核实工作后补 task_execution_report。终态不可回退，idle 不是完成证明。最后 task_get 确认回写，再通过 task_execution_recover 记录 busy/unknown/resumed 审计。
purpose=status 禁止 stopped；默认 recovery 兼容旧等待恢复路径，仍须原有快照和完整宿主观测。相同用途的 60 秒内 pending 检查合并，不同用途不互相覆盖。新 purpose 与状态检查观察字段需新插件整体加载。

- 消息发送成功：记录 delivered，提示已投递、等待真实开始回执。
- SDK 明确拒绝或接收 Agent 在尚无创建结果时明确不能处理：记录 rejected 和错误摘要。
  这不是已运行任务的 failed 回执；用户可以显式提交新尝试，不能自动换模型或工作方式。
- 超时、传输异常或创建结果未知：记录 uncertain，核对原操作，不自动重发或重复创建。
- 原生工具结果就绪后立即保存真实结果；已有映射必须复用，未知结果禁止再次创建。
- 真正开始和完成：目标聊天核对自身绑定后报告 running/completed，不由发送者代报。

非 Codex 或身份未知时默认不执行，不提供 CLI、App Server、后台执行器或私有注入兜底。

## 模型（存储 v4）

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
已记录请求的明确拒绝、结果未知、失败或完成不自动切回 human，异常由请求/执行状态独立表达。保留 MCP `task_assign` 供既有调用者显式管理元数据，不提供其 UI 入口。

`executionBinding`：

- `provider: 'codex-desktop'`
- `threadId`、`hostId`：原生工具返回的就绪标识；拒绝 `sess-*` 和创建中占位标识。
- `workspacePath`：实际执行目录的绝对路径。
- `workspaceOwner: 'codex' | 'tasklane' | 'user'`：独立新工作区属于 Codex；旧工作区属于 TaskLane；主仓库属于用户。
- `branch?`、`boundAt`：实际分支和服务端绑定时间。

`executionRequests` 持久保存每次请求及其关联结果，包含 `requestId`、服务端 `runId`、
`taskId`、`boardId`、`action`、`workspaceMode`、可选的不可变 hostId/receiverThreadId 路由提示、
认领时的实际 `receiver: { hostId, threadId }`、`repo`、
`message?`、`model?`、`status`、`requestedAt`、`updatedAt`、`claimId?`、`result?`、`startedAt?`、
`reports?`、`deliveryError?`。保留完整回复，不用活动摘要代替。

请求状态包括 `pending / delivered / claimed / created / bound / running / waiting / blocked / completed / failed / uncertain / rejected / cancelled`。
等待传输或创建时 `execution.state` 为 `starting`，投递/创建/绑定都不写 `running`。

## MCP 工具

以下工具的 `boardId` 均必填，事务内重查归属和归档守卫。标识符均为非空、长度不超过 200 的字符串。

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `task_execution_request` | `id, boardId, requestId, action: start/reply/continue/retry, workspaceMode: project/worktree/existing, hostId?, receiverThreadId?, message?, model?` | `{ task, request, created }` |
| `task_execution_recovery_request` | `id, boardId, requestId, runId, checkId, purpose?: status/recovery` | `{ task, request, created }` |
| `task_execution_recover` | `id, boardId, requestId, runId, checkId, checkerThreadId, hostId, outcome, message, observations, confirmedStopped?` | `{ task, request, changed }` |
| `task_execution_delivery` | `id, boardId, requestId, runId, status: delivered/uncertain/rejected/blocked, error?, claimId?` | `{ task, request }` |
| `task_execution_claim` | `id, boardId, requestId, runId, claimId, hostId?, receiverThreadId?` | `{ task, request, claimed }` |
| `task_execution_bind` | `id, boardId, requestId, runId, claimId, phase: created/bound, threadId, hostId, workspacePath, workspaceOwner, branch?` | `{ task, request }` |
| `task_execution_report` | `id, boardId, requestId, runId, threadId, hostId, reportId, state: running/waiting/blocked/failed/completed, activity?` | `{ task, request }` |

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
  普通 `task_assign` 只改负责人；`task_move` 只改业务状态及读取已有工作区的变更摘要。
- delivery 迟到不能覆盖认领/绑定/运行回执；超时为 `uncertain`，不能把未知结果记成失败或停止。
- 接收 Agent 认领后 rejected 必须匹配 claimId 且尚无 created/result；面板迟到的拒绝不能
  覆盖已认领操作。rejected 不写 running、failed 或 startedAt，错误须为非空且不超过 200 字符。

错误码：`EXECUTION_BUSY`、`EXECUTION_CONFLICT`、`EXECUTION_STALE`、`EXECUTION_REPORT_REQUIRED`，
以及现有 `VALIDATION / BOARD_MISMATCH / TASK_ARCHIVED / GIT_ERROR`。
这些关联校验不证明调用者身份；本地 MCP 通道的信任边界保持不变。

## 迁移和验收边界

v1/v2/v3 在文件锁内重读、完整校验、备份为 `.vN.bak` 后原子迁移到 v4。
本轮扩展 v4 的可选 receiver 和 rejected 状态；旧 v4 记录继续可读，旧 0.3.2 服务可能
拒绝读取新格式请求，使用新流程写入前需要重载插件并停用同目录旧服务，不混用写进程。
任务、归档、时间线、序号和 Git 绑定保留；旧 running 无真实绑定时展示为未核实。
升级前须由用户停用同一数据目录的旧写进程；本次验证只操作临时数据，不迁移用户真实看板。
回滚不覆盖新增写入、不删除聊天和工作区。

协议自动化测试和浏览器宿主模拟不证明当前 Codex Desktop 原生路由可用。
真实项目入口、全局入口、工作区复用和深链接验收须单独记录；能力缺失在实际任务中明确报错。

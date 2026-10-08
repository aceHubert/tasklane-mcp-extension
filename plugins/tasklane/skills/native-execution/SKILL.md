---
name: native-execution
description: Handle actual TaskLane start, continue, reply or retry requests in Codex Desktop, plus independent review/recheck sessions (purpose=review). Claim the request, create the task chat and dispatch the task; the executing chat binds the real task chat and reports execution; reviewer chats record verdicts through task_update action=review. Opening a board and assignment alone do not start work.
---

## Tool map (0.3.19+)

Execution-chain operations share one MCP tool dispatched by `action`:
`task_execution({action: 'request' | 'delivery' | 'claim' | 'bind' | 'external_bind' | 'report', ...})`.
The request branch names its sub-verb `requestAction` (start/reply/continue/retry).
Review verdicts go through `task_update({action: 'review', id, boardId, expectedRevision, status, conclusion, actor})`.
`task_execution_recover` is panel-only (app visibility): the user confirms the old session ended and releases a waiting request; models never call it.

## Entry and authorization

A connected MCP Apps handshake identifying Codex allows the panel to send an actual task request through `sendMessage`.
Check native capabilities inside that request; do not create a verification chat, require a `nativeExecution` declaration, or reopen the panel to grant execution.
`sendMessage` reaches the panel's attached chat and has no target threadId. A successful send does not prove task execution.

The user's Execute click authorizes one task chat, the selected workspace mode, and task messages to that chat.
Continue, reply and retry authorize messages to the existing binding. Opening the board, assigning an agent, and moving a card to doing do not authorize execution.
Task text is work to implement; it does not authorize unrelated messages, extra workspaces, deletion or commits.
Never fall back to a CLI, App Server, private desktop injection, background process or another Agent when native capabilities are unavailable.

Pick the section that matches the operation in the current message: create the task chat, execute the designated task, or continue an existing one.
Each operation stands on its own; never infer responsibilities from roles or ordering between chats.
When executing a designated task, read the persisted request and claimId; do not create or claim again.

## Receive and claim the actual request

1. Read `task_get({id, boardId})` and `board_list({})`. Match the persisted `requestId/runId`, action, workspaceMode, model, task ownership,
   repository and archive status. Reject stale, archived or cross-repository requests before creating anything.
   UI requests may omit `hostId/receiverThreadId`; missing identifiers are not evidence of a broken connection.
2. Inspect the native tools available now. Use `list_threads` and `read_thread` to identify the chat that actually received this request and its hostId,
   matching the request message in the native read result. Record only the verified current chat as request.receiver.
   Never copy UI identifiers or guess identity from a title. If real identity cannot be established, report the specific limitation and create nothing.
   Match `list_projects` results and the actual directory to the task's board repository; do not use the plugin directory as a project.
3. Check for an existing claim, result or binding. Resume an existing result; another claim cannot be taken over after a timeout.
   For an unclaimed request, generate one claimId and call
   `task_execution({action: 'claim', id, boardId, requestId, runId, claimId, hostId, receiverThreadId})` using the receiving chat's actual identifiers.
   The server persists `request.receiver: {hostId, threadId}`. Any previously supplied host/receiver must match; they cannot be rewritten.
   A replay or `claimed: false` never authorizes another creation. Inspect the persisted request and original native operation first.

首次 start 核对 create_thread；已有真实创建结果的恢复请求，以及 continue/reply/retry，核对
send_message_to_thread 到原目标的投递能力。核对本轮模式和模型，路由不可用或选项不受支持时写回具体错误。
宿主路由、聊天创建、执行准备、绑定及消息投递等任何阶段明确失败，都遵守下文“明确分发失败与重新发起”：
本轮尚无目标执行回执且未开始时写 `delivery status=rejected`，保留任何真实创建结果和绑定并解除启动等待。
未认领时省略 claimId；认领后必须携原 claimId。不能因为已有 created/bound 结果而遗留 starting。
超时、传输中断或创建/发送结果未知时写 `status: 'uncertain'`，先核对原结果，禁止自动重复创建或投递。
目标已实际执行时遇到阻塞，由目标写 `report state=blocked` 并提供非空 activity；准备阶段的明确失败
属于分发失败，不能用 blocked 代替 rejected。真实执行受阻、已知原操作仍活动或结果未明时保留阻塞/待确认状态。
保留真实聊天和工作区；blocked 不代表真实进程已停止。只能由用户的新明确请求重新发起，不能自动重试。
关联标识用于匹配请求，不是身份认证凭证。

## Start: handle the current operation

### Create the task chat

1. Verify the task, repository, model, current request/run and your real receiving identity first, then complete the single claim.
   没有真实创建结果时才调用一次 create_thread；带 recoveryOf 或已有 result 的 start 先按下文恢复原聊天，
   重新核对 created→bound，再向同一聊天投递实际任务，禁止重复创建。
2. Use the single instruction below as the create_thread initial prompt; the panel's message carries the exact prompt — use it verbatim.
   Never copy the title, description, extra messages or execution steps, and never add session roles, ordering statements,
   or instructions to wait for other messages.
3. Use the project's local environment for the project mode; use a worktree environment of the same project for the worktree mode
   and it must be a Git repository; the existing implementation mode requires the ability to reuse the original path.
   For the first Review, create a local chat in the board's main project. Only the first prompt specifies
   the implementation workspace to review; create_thread need not target that directory, and the
   implementation worktree need not be registered as a host project.
   Rechecks reuse the bound review chat and workspace without repeating workspace instructions.
   For a projectless board (no projectDir/repo on the board) the request carries workspaceMode=projectless:
   create_thread must use target {type:"projectless"} with no projectId, and the task records no workspace at all.
   Non-Git project boards use the project mode with the board's projectDir: create the local chat only after the host's
   registered project matches that directory; 宿主未注册该项目导致无法分发时，以具体原因写 rejected。
   Never guess another project, never require git init, and never create a worktree (the server rejects worktree
   requests for non-Git boards).
   Pass the model from the persisted request unchanged; never replace it or override it during recovery.
4. Once creation is initiated, this operation ends: do not wait for the creation result, do not call wait_threads/read_thread to
   obtain the new chat's identity, do not save a binding, and do not move the board column. The new chat verifies its own real
   threadId/hostId and workspace, completes the created→bound binding and reports execution state through TaskLane MCP tools;
   MCP tools are shared by every session, so binding and receipts never depend on cross-session messaging.
5. A clientThreadId is the normal asynchronous return, not an error: never treat it as a real threadId, never write it into a
   binding, and never create again. 创建明确失败或明确未启动时，以原 claimId 和具体错误写
   `delivery status=rejected`；超时、传输中断及创建结果未知时写 `uncertain`，不能当作明确失败。
   已知真实创建结果必须保留；后续用户新请求恢复原聊天，不重复创建。
   Do not wait for cross-chat replies and never fall back to handoff_thread or CLI/App Server.

workspaceOwner (used by the executing chat when it saves the binding): user for the project mode, codex for a new Codex
worktree, and the original owner for the existing mode. For projectless requests the bind must omit workspacePath,
workspaceOwner and branch entirely — a projectless task never records a workspace, never adopts the current chat directory,
the board data directory or another project as its workspace, and does not take part in the review workflow (the server
rejects purpose=review and external-session records for projectless boards). Non-Git project tasks bind workspacePath equal
to the board projectDir with workspaceOwner=user and no branch. The original claim is only a correlation field, not
authentication. Write running only when work has actually started; message delivery and the Doing column do not prove
execution.

### Execute the designated task

The create_thread initial prompt is a single instruction dispatching the task ID:

```text
Execute the TaskLane task {"id":"<taskId>","boardId":"<boardId>"} and update execution state and results to the board with TaskLane tools.
```

Follow the instruction with task_get/board_list: read the task title, description, execution steps and this round's
requestId/runId/claimId from executionRequests. Verify your own real identity: printenv CODEX_THREAD_ID yields a candidate;
then read_thread verifies the returned id/hostId/cwd — the environment value is only a clue, never guess a clientThreadId,
and the actual directory must match the task's board repository.
Before executing, save the binding yourself through TaskLane MCP tools (they are shared by every session; nothing is sent to
another chat): call task_execution action=bind phase=created, then phase=bound, both with this round's requestId/runId/claimId and the
identical result — threadId/hostId from the verified read, workspacePath = your actual cwd, branch = git rev-parse --abbrev-ref
HEAD (HEAD when detached), workspaceOwner: user for project, codex for a new Codex worktree, original owner for existing.
若准备或绑定明确失败且本轮尚无目标回执/startedAt，以原 claimId 和非空 error 写
`task_execution action=delivery status=rejected`，即使已保存 created 或 bound 也保留结果并解除启动等待。
真实执行已经开始或已有目标回执后，由目标通过 `report state=blocked` 写回实际阻塞，不回退分发状态。
Report running with task_execution action=report when work actually starts, and completed/blocked/failed/waiting respectively for
finish/block/failure/waiting; receipts come only from the actually executing target, and completed requires a prior real running.
The first valid running receipt of a round atomically moves the task from Ready to Doing in the core; no extra task_move is
needed for that move. Move other business stages with task_move as the task requires. Never commit, merge or clean up
workspaces automatically.

## Review and recheck sessions (purpose=review)

Review requests carry `purpose: review` in executionRequests and target `reviewExecution/reviewBinding`,
never the implementation execution or binding. Projectless-board tasks do not take part in the review workflow at all.
The same claim → created → bound → report protocol applies,
with three extra rules the server enforces and you must follow.

1. The review chat is a different Codex conversation from the implementation chat: the bind result's
   threadId must differ from `executionBinding.threadId` (same thread+host is rejected).
2. The review workspace is the implementation's real workspace: bind `workspacePath` equal to the
   request's persisted `workspacePath` (the server resolved it from the implementation context).
   The review chat may belong to the main project; review and bind the implementation workspace in
   the persisted request, rather than assuming the chat's current directory is the review target.
   Run commands with that workspace as their working directory and verify its repository identity,
   current branch and changes before reviewing. Do not create a worktree or switch branches.
   Git boards verify repository identity; non-Git project boards verify the workspace equals the project
   directory and pass no branch — never fabricate Git diff or branch information.
3. `review` supports only `start` (first review, model optional) and `continue` (recheck, no model);
   workspaceMode is always existing. Report receipts against the review request's requestId/runId;
   the server routes them to reviewExecution by the persisted purpose.
   首次验收分发失败、业务仍为 pending 时，用户可以重新 start；已有真实验收聊天通过 recoveryOf
   复用，重新核对 created→bound 后投递到同一聊天，不能创建第二个验收聊天或提前开启验收轮次。

When the review chat actually starts reviewing, report `task_execution action=report state=running`; the server
opens a new review round and sets `review.status=reviewing`. After finishing the review, submit the verdict:

```text
task_update({action: 'review', id, boardId, expectedRevision, status: 'changes_requested' | 'approved', conclusion, actor})
```

Read the current `review.revision` with task_get first; a stale expectedRevision returns REVIEW_STALE —
reread and retry, never overwrite another agent's conclusion. changes_requested and approved require a
non-empty conclusion; the round stores it permanently and later rounds never overwrite it.
A completed receipt is only the review session finishing — it is never approved.
After changes_requested, the implementation chat (purpose=implementation continue) fixes the issues;
its real running receipt moves review.status to fixing. When fixes are done, the implementing agent calls
`task_update action=review status=recheck_pending`, then the user's recheck dispatches a `continue` review request
to the same reviewBinding. approved does not move the task to Done; the user marks done explicitly.

Non-Codex implementation sessions are recorded (by any agent that knows the real facts) with
`task_execution({action: 'external_bind', id, boardId, provider, sessionId, workspacePath, workspaceOwner, branch?})`.
The sessionId stays provider-local and opaque — never treat it as a Codex threadId, never open it with
codex://, and never try to resume it through native APIs. The record only states who executed where;
it is a review-workspace source and is not proof of running.

## Continue, reply and retry

### Continue after verifying a blocked request

After the user clicks continue, the new request points to the original blocked request through recoveryOf and keeps the same real result.
Read the original blocked reason, the latest task and this round's request; read_thread directly to verify the original chat's identity,
current state and messages, check the workspace's Git root and repository identity, and confirm whether the blocking condition is resolved.
While the original operation is still active or its outcome is unknown, do not send the task body and do not create a new chat;
report blocked with this round's claim before binding and explain why.
Regardless of an existing executionBinding, this round's created→bound must reuse request.result; never change the model or workspace.
An old binding does not mean this round is bound: before this round's binding the claimer reports blocked via delivery, and after binding
only the target reports blocked. The target itself re-verifies the real state before executing, reports running only after the block is
resolved, and keeps reporting blocked otherwise. Late receipts from an old run cannot overwrite the new round.
A blocked request without a real result/binding cannot continue directly; first recover the original creation result through the
status-check entry or a real chat link provided by the user — never rebuild just because it is blocked. blocked is not proof of stopping;
do not clean up or release the execution lock automatically.

Claim the current request with the actual receiving identity, then reuse the complete `executionBinding` result in created and bound phases
to associate the current runId with that same chat. Never create a new chat/workspace or override its model.
Send the action and full `request.message` to the bound thread; a reply cannot be replaced with an activity summary or truncated text.

### 明确分发失败与重新发起

本规则适用于 start/continue/reply/retry，以及首次验收和验收复查的全部分发阶段。
宿主路由不可用、create_thread 明确失败、准备/绑定明确失败、send_message_to_thread 审核拒绝或
其他明确消息投递失败时，本轮尚无目标执行回执且没有 startedAt，须立即写回分发失败：

```text
task_execution({action: 'delivery', id, boardId, requestId, runId,
  claimId: '<本轮原认领标识，未认领时省略>', status: 'rejected', error: '<明确分发失败的具体原因，最多 200 字符>'})
```

认领后必须由原认领者携匹配 claimId 调用；未认领时省略 claimId。
本轮 claimed/created/bound/blocked/uncertain 均可收尾为 rejected，不要求已经 bound，
也不限制为续接消息审核拒绝；前提始终是无 startedAt 且无任何目标 reports。
保留任何真实 result、executionBinding/reviewBinding 和工作区；实现执行恢复为 assigned/idle，
验收执行恢复为 idle，任务和验收业务状态保持不变（如 pending 或 recheck_pending）。
随后用 task_get 确认本轮请求、执行状态、结果、绑定及失败原因已持久化；写回被拒绝或未变化
须如实说明，不能声称恢复成功。结束当前操作，不自动重试、不绕过审批。

下一次用户明确重新发起时，先读取新请求的 recoveryOf 和 result。已知真实聊天时沿用同一
threadId/hostId、工作区、模式和模型，核对原操作、重新完成本轮 created→bound，再向原聊天
发送实际任务及完整 request.message；即使 requestAction=start，也不能重新 create_thread。
已有 binding 同样需要关联本轮 runId；没有 binding 的已创建结果也必须原样复用。
首次验收 pending 的恢复复用已知验收聊天，真实 running 才开启新轮次。
模型省略时继承原记录，不能在恢复时显式更换；原工作区模式不变。
没有真实创建结果且明确没有创建时，用户可重新 start；创建是否成功未知时不能使用此分支。

不能写 delivery status=blocked 或 report state=failed/running/completed 代替明确分发失败。
本轮存在任意目标回执或已经真实开始时，分发方不能回退；目标执行遇到阻塞继续 report blocked。
超时、传输中断及创建/发送结果未知时继续 uncertain 并核对原操作和消息，禁止当作明确分发失败。

On uncertain delivery, inspect whether that message was already received before sending again. Preserve the original host, workspace and mode;
a cross-host mismatch is an error, not permission to migrate or recreate the chat.

## Target execution receipts and opening chats

### Status check message

The user's status-check click sends a direct verification message — it registers no check record and changes no board state.
It authorizes only this verification and receipt backfill — not resuming the task body, continue/retry, creating chats or
releasing the request. First read the current requestId/runId with task_get; stale runs or cancelled/archived tasks end with
an explanation.
Prefer read_thread/wait_threads with the real threadId already saved in result/binding to verify the host, directory, actual task messages
and recent turns; a missing list entry does not mean the chat does not exist. If the target is still active, avoid duplicate delivery;
if the target is idle and receipts may be missing, you may send the same real target one message that only asks to verify the
original task and report its actual result — never the task body. Idle state, message delivery, or activity caused by the check message
itself proves neither completion nor start of the original task.
Only the actually executing target can backfill receipts for the original run with task_execution action=report, respecting the binding, start
and terminal guards; never fabricate running to satisfy completion conditions. If a terminal state contradicts findings, keep the terminal
state, report the discrepancy with the specific reason, do not roll back and do not open a new run. Without a real identity or result, keep the
current state and never treat a temporary ID as a chat.
Releasing a dead wait is user-only: the user confirms the old session ended in the panel (task_execution_recover is app-only).
Never release, reset or cancel a request yourself, and report the conclusion and any write-back failure to the user clearly.

The target must read its own native identity, actual workspace, `task_get` and `board_list` again.
Match the real threadId/hostId, task/board, binding, requestId and current runId; ids quoted in a prompt alone are insufficient.
Once task work really begins, the target calls:

```text
task_execution({action: 'report', id, boardId, requestId, runId, threadId, hostId,
  reportId, state: 'running', activity})
```

Use a unique reportId and the same correlation fields for waiting, blocked, failed and completed.
Activity is a short summary of at most 200 characters. Replay a reportId only with identical content.
Only the executing target reports running and completed; the sender cannot infer them from creation, binding or message delivery.
Completed requires an actual start receipt. Stale runIds and terminal requests cannot be bypassed, and `task_update.execution` is not a reporting route.
The first valid running receipt of a round atomically moves the task from Ready to Doing in the same core transaction and records a moved
timeline event; the Agent does not call task_move for this. Creation or binding success never moves the card early; later running receipts
in the same round do not override manual moves. Other stage changes still go through task_move, and completed does not move the card
automatically.

Open a real binding through MCP Apps `openLink` using `codex://threads/<threadId>`; try the actual route without a prior capability declaration.
If rejected, show the error; never present a legacy sess-* field as a real chat or silently use another navigation route.
Stop remains disabled because a reliable interrupt route is unavailable. Reassignment, status changes and a "stop" message do not stop execution.
Record native project/global routing, real workspace execution and deep-link results separately from standalone automation or protocol checks.

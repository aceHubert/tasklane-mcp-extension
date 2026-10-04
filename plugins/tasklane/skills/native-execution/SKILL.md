---
name: native-execution
description: Handle actual TaskLane start, continue, reply or retry requests in Codex Desktop. Claim the request, create the task chat and dispatch the task; the executing chat binds the real task chat and reports execution. Opening a board and assignment alone do not start work.
---

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
   `task_execution_claim({id, boardId, requestId, runId, claimId, hostId, receiverThreadId})` using the receiving chat's actual identifiers.
   The server persists `request.receiver: {hostId, threadId}`. Any previously supplied host/receiver must match; they cannot be rewritten.
   A replay or `claimed: false` never authorizes another creation. Inspect the persisted request and original native operation first.

For start, verify create_thread; for continue/reply/retry, verify send_message_to_thread delivery to the existing target.
Check support for the selected mode and model in this actual request. An unavailable route or unsupported choice must produce a specific error.
For a known rejection before any creation/result, call
`task_execution_delivery({id, boardId, requestId, runId, status: 'rejected', error, claimId})`;
omit claimId if not yet claimed, otherwise use the owning claimId. Never reject after a created/result exists.
Use `status: 'uncertain'` for a timeout or unknown outcome, then inspect existing results instead of automatically repeating the action.
When a blocking condition is confirmed or user handling is required, write it back as `blocked`; never merely explain in chat and finish.
Before binding, the claimer uses `task_execution_delivery status=blocked` with the correct claimId and a non-empty error;
after binding, the target uses `task_execution_report state=blocked` with a non-empty activity.
Preserve the real chat and workspace; blocked does not mean the real process has stopped.
A confirmed rejection can be retried only through a new explicit user request. Correlation identifiers are not authentication credentials.

## Start: handle the current operation

### Create the task chat

1. Verify the task, repository, model, current request/run and your real receiving identity first, then complete the single claim.
   Call create_thread exactly once; an existing creation result must be reused.
2. Use the single instruction below as the create_thread initial prompt; the panel's message carries the exact prompt — use it verbatim.
   Never copy the title, description, extra messages or execution steps, and never add session roles, ordering statements,
   or instructions to wait for other messages.
3. Use the project's local environment for the project mode; use a worktree environment of the same project for the worktree mode
   and it must be a Git repository; the existing mode requires the ability to reuse the original path.
   Pass the model from the persisted request unchanged; never replace it or override it during recovery.
4. Once creation is initiated, this operation ends: do not wait for the creation result, do not call wait_threads/read_thread to
   obtain the new chat's identity, do not save a binding, and do not move the board column. The new chat verifies its own real
   threadId/hostId and workspace, completes the created→bound binding and reports execution state through TaskLane MCP tools;
   MCP tools are shared by every session, so binding and receipts never depend on cross-session messaging.
5. A clientThreadId is the normal asynchronous return, not an error: never treat it as a real threadId, never write it into a
   binding, and never create again. Only when creation is explicitly rejected or the call fails, call task_execution_delivery
   status=rejected/uncertain with the owning claimId and a specific error.
   Do not wait for cross-chat replies and never fall back to handoff_thread or CLI/App Server.

workspaceOwner (used by the executing chat when it saves the binding): user for the project mode, codex for a new Codex
worktree, and the original owner for the existing mode. The original claim is only a correlation field, not authentication.
Write running only when work has actually started; message delivery and the Doing column do not prove execution.

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
another chat): call task_execution_bind phase=created, then phase=bound, both with this round's requestId/runId/claimId and the
identical result — threadId/hostId from the verified read, workspacePath = your actual cwd, branch = git rev-parse --abbrev-ref
HEAD (HEAD when detached), workspaceOwner: user for project, codex for a new Codex worktree, original owner for existing.
If a precondition blocks the binding, write it back: before bound, call task_execution_delivery status=blocked with the original
claimId and a non-empty error; after bound, report state=blocked with a non-empty activity.
Report running with task_execution_report when work actually starts, and completed/blocked/failed/waiting respectively for
finish/block/failure/waiting; receipts come only from the actually executing target, and completed requires a prior real running.
The first valid running receipt of a round atomically moves the task from Ready to Doing in the core; no extra task_move is
needed for that move. Move other business stages with task_move as the task requires. Never commit, merge or clean up
workspaces automatically.

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
On uncertain delivery, inspect whether that message was already received before sending again. Preserve the original host, workspace and mode;
a cross-host mismatch is an error, not permission to migrate or recreate the chat.

## Target execution receipts and opening chats

### Status check (purpose=status)

The user's status-check click authorizes only this verification and receipt backfill — not resuming the task body, continue/retry,
creating chats or releasing the request. First read the current requestId/runId/checkId and recoveryCheck.purpose with task_get;
the purpose must be status, and stale runs or cancelled/archived tasks end with an explanation.
Prefer read_thread/wait_threads with the real threadId already saved in result/binding to verify the host, directory, actual task messages
and recent turns; a missing list entry does not mean the chat does not exist. If the target is still active, record busy and avoid duplicate
delivery; if the target is idle and receipts may be missing, you may send the same real target one message that only asks to verify the
original task and report its actual result — never the task body. Idle state, message delivery, or activity caused by the check message
itself proves neither completion nor start of the original task.
Only the actually executing target can backfill receipts for the original run with task_execution_report, respecting the binding, start
and terminal guards; never fabricate running to satisfy completion conditions. If a terminal state contradicts findings, keep the terminal
state, report unknown with the specific reason, do not roll back and do not open a new run. Without a real identity or result, keep the
current state and never treat a temporary ID as a chat.
Then reread task_get to confirm the persisted state, and record the check conclusion with fresh observations via task_execution_recover as
busy/unknown/resumed. resumed here only means the receipts have been verified, not that execution restarted; purpose=status strictly forbids
outcome=stopped and never clears claim, run, chat or workspace. Report the conclusion and any write-back failure to the user clearly.

The target must read its own native identity, actual workspace, `task_get` and `board_list` again.
Match the real threadId/hostId, task/board, binding, requestId and current runId; ids quoted in a prompt alone are insufficient.
Once task work really begins, the target calls:

```text
task_execution_report({id, boardId, requestId, runId, threadId, hostId,
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

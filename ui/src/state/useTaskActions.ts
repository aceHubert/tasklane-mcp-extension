import { useCallback, useRef } from 'react';
import { useBoard } from './BoardContext';
import { useLang } from '../i18n';
import {
  executionBlockReason, executionStatus, executionTarget, openThreadBlockReason, type ExecutionAction, type ExecutionTask,
} from '../host';
import { boundWorkspaceMode, dispatchNativeExecution, recoverPendingExecution } from './nativeExecution';
import type { ExecutionRequest, TaskStatus, WorkspaceMode } from '../mcp/types';

export function useTaskActions(task: ExecutionTask) {
  const { mutate, call, toast, board, executionHost, hostSnapshot, isCurrentBoard } = useBoard();
  const { t } = useLang();
  const inFlight = useRef(false);
  const taskId = task.id;
  const boardId = task.boardId;
  const agentName = hostSnapshot.identity === 'codex' ? 'Codex' : 'Agent';
  const mode = boundWorkspaceMode(task);
  const reason = (action: ExecutionAction, workspaceMode?: WorkspaceMode) =>
    executionBlockReason(hostSnapshot, task, board?.repo, action, action === 'start' ? workspaceMode : mode);

  const move = useCallback((status: TaskStatus) => mutate(
    () => call('task_move', { id: taskId, status, boardId }),
    t('toast.mcpOk', { call: `task_move(${taskId} → ${status})` }),
  ), [mutate, call, taskId, boardId, t]);

  const execute = async (action: ExecutionAction, workspaceMode: WorkspaceMode, message?: string, model?: string) => {
    const blocked = reason(action, workspaceMode);
    if (blocked || !executionHost || !isCurrentBoard(boardId)) {
      toast('err', t(`native.reason.${blocked ?? 'context'}`));
      return false;
    }
    if (inFlight.current) return false;
    inFlight.current = true;
    const contextVersion = hostSnapshot.contextVersion;
    try {
      let accepted = false;
      const ok = await mutate(async () => {
        const result = await dispatchNativeExecution({
          task, repo: board?.repo, host: executionHost, snapshot: hostSnapshot, call,
          action, workspaceMode, message, model,
          isCurrent: () => isCurrentBoard(boardId) && executionHost.getSnapshot().contextVersion === contextVersion,
        });
        accepted = result === 'delivered';
        if (isCurrentBoard(boardId)) toast(result === 'uncertain' || result === 'rejected' ? 'err' : 'ok',
          t(result === 'rejected' ? 'native.deliveryRejected' : result === 'uncertain' ? 'native.deliveryUncertain' :
            result === 'existing' ? 'native.requestExists' : 'native.requestSent'));
      });
      return ok && accepted;
    } finally { inFlight.current = false; }
  };

  const openSession = async () => {
    const blocked = openThreadBlockReason(hostSnapshot, task);
    if (blocked || !executionHost || !isCurrentBoard(boardId)) {
      toast('err', t(`native.reason.${blocked ?? 'context'}`));
      return false;
    }
    try {
      await executionHost.openLink(`codex://threads/${encodeURIComponent(executionTarget(task)!.threadId)}`, hostSnapshot.contextVersion);
      if (isCurrentBoard(boardId)) toast('ok', t('native.opened'));
      return true;
    } catch (err) {
      toast('err', `${t('native.reason.open')} (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }
  };

  const recover = (request: ExecutionRequest) => mutate(
    async () => {
      const result = await recoverPendingExecution({ task, request, call, host: executionHost, snapshot: hostSnapshot,
        confirmed: true, isCurrent: () => isCurrentBoard(boardId) });
      if (isCurrentBoard(boardId)) toast('ok', t(result === 'existing' ? 'native.recovery.exists' : 'native.recovery.sent'));
    },
  );

  const archive = useCallback(() => mutate(
    () => call('task_archive', { id: taskId, boardId }),
    t('toast.mcpOk', { call: `task_archive(${taskId})` }),
  ), [mutate, call, taskId, boardId, t]);

  const restore = useCallback(() => mutate(
    () => call('task_restore', { id: taskId, boardId }),
    t('toast.mcpOk', { call: `task_restore(${taskId})` }),
  ), [mutate, call, taskId, boardId, t]);

  return {
    move,
    start: (workspaceMode: WorkspaceMode, model?: string) => execute('start', workspaceMode, undefined, model),
    continueExecution: () => execute('continue', mode),
    retry: () => execute('retry', mode),
    reply: (text: string) => execute('reply', mode, text),
    stop: async () => { toast('err', t('native.reason.stop')); return false; },
    openSession, recover, archive, restore, reason,
    openReason: openThreadBlockReason(hostSnapshot, task),
    status: executionStatus(task), requests: task.executionRequests ?? [], agentName,
  };
}

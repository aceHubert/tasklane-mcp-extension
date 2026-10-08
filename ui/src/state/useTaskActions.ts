import { useCallback, useRef } from 'react';
import { useBoard } from './BoardContext';
import { useLang } from '../i18n';
import {
  executionBlockReason, executionStatus, executionTarget, openThreadBlockReason, reviewBlockReason,
  type ExecutionAction, type ExecutionTask, type ReviewAction,
} from '../host';
import { boundWorkspaceMode, dispatchNativeExecution, recoverPendingExecution, releaseWaitingExecution } from './nativeExecution';
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
    executionBlockReason(hostSnapshot, task, board, action, action === 'start' ? workspaceMode : mode);
  const reviewReason = (action: ReviewAction) => reviewBlockReason(hostSnapshot, task, action, board);

  const move = useCallback((status: TaskStatus) => mutate(
    () => call('task_move', { id: taskId, status, boardId }),
    t('toast.mcpOk', { call: `task_move(${taskId} → ${status})` }),
  ), [mutate, call, taskId, boardId, t]);

  const execute = async (
    action: ExecutionAction,
    workspaceMode: WorkspaceMode,
    message?: string,
    model?: string,
    purpose: 'implementation' | 'review' = 'implementation',
  ) => {
    const blocked = purpose === 'review'
      ? reviewReason(action === 'start' ? 'review-start' : 'review-continue')
      : reason(action, workspaceMode);
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
          task, board, host: executionHost, snapshot: hostSnapshot, call,
          action, workspaceMode, purpose, message, model,
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

  const openSession = async (purpose: 'implementation' | 'review' = 'implementation') => {
    const blocked = openThreadBlockReason(hostSnapshot, task, purpose);
    if (blocked || !executionHost || !isCurrentBoard(boardId)) {
      toast('err', t(`native.reason.${blocked ?? 'context'}`));
      return false;
    }
    try {
      await executionHost.openLink(`codex://threads/${encodeURIComponent(executionTarget(task, purpose)!.threadId)}`, hostSnapshot.contextVersion);
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

  // 解除等待：用户确认旧会话已结束，取消等待中的执行请求（app-only task_execution_recover）
  const release = (request: ExecutionRequest) => mutate(
    async () => {
      const result = await releaseWaitingExecution({ task, request, call,
        confirmed: true, reason: t('native.release.reason'), isCurrent: () => isCurrentBoard(boardId) });
      if (isCurrentBoard(boardId)) toast('ok', t(result === 'released' ? 'native.release.done' : 'native.release.exists'));
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
    continueExecution: (message?: string) => execute('continue', mode, message),
    retry: () => execute('retry', mode),
    reply: (text: string) => execute('reply', mode, text),
    // Review 动作：首次验收（可选模型）/ 继续验收（复用 reviewBinding）/ 按结论继续修改（实现会话）
    startReview: (model?: string, message?: string) => execute('start', 'existing', message, model, 'review'),
    continueReview: (message?: string) => execute('continue', 'existing', message, undefined, 'review'),
    continueFix: (message?: string) => execute('continue', mode, message),
    stop: async () => { toast('err', t('native.reason.stop')); return false; },
    openSession, openReviewSession: () => openSession('review'), recover, release, archive, restore, reason, reviewReason,
    openReason: openThreadBlockReason(hostSnapshot, task),
    openReviewReason: openThreadBlockReason(hostSnapshot, task, 'review'),
    status: executionStatus(task), requests: task.executionRequests ?? [], agentName,
  };
}

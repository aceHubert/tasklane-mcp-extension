import type { BoardSummary, Priority, SessionEvent, TaskStatus, WorkItem, WorkspaceMode, ExecutionBinding, ExecutionRequest, ExecutionResult } from '@tasklane/core';
import { translate } from '../i18n/messages';

export interface TaskDetailPayload {
  task: WorkItem;
  timeline: SessionEvent[];
}

/** 与 core 引擎一致的流转表（用于禁用无效选项；最终校验仍在 MCP 侧） */
export const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['ready', 'doing'],
  ready: ['doing', 'backlog'],
  doing: ['review', 'ready'],
  review: ['done', 'doing'],
  done: ['review'],
};

export const STATUS_ORDER: TaskStatus[] = ['backlog', 'ready', 'doing', 'review', 'done'];

export type { BoardSummary, Priority, TaskStatus, WorkItem, SessionEvent, WorkspaceMode, ExecutionBinding, ExecutionRequest, ExecutionResult };

export function timeAgo(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return translate('time.justNow');
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/** 「N 分钟前 / Nm ago」封装：刚刚（just now）自带时态，不再拼后缀 */
export function agoText(iso?: string): string {
  const rel = timeAgo(iso);
  if (!rel || rel === translate('time.justNow')) return rel;
  return translate('time.ago', { time: rel });
}

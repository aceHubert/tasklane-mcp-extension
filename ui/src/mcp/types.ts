import type { BoardSummary, Priority, SessionEvent, TaskStatus, WorkItem, WorkspaceMode, ExecutionBinding, ExecutionRequest, ExecutionResult, ExecutionPurpose, ExternalExecutionSession, ReviewBinding, ReviewRound, ReviewUpdate, TaskReview } from '@tasklane/core';
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

export type { BoardSummary, Priority, TaskStatus, WorkItem, SessionEvent, WorkspaceMode, ExecutionBinding, ExecutionRequest, ExecutionResult, ExecutionPurpose, ExternalExecutionSession, ReviewBinding, ReviewRound, ReviewUpdate, TaskReview };

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

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 截止时间 → datetime-local 输入值（本地时区 YYYY-MM-DDTHH:mm；无值或坏值返回空串） */
export function toLocalInputValue(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * datetime-local 本地值 → 带时区的 UTC ISO：必须在浏览器侧完成本地时区换算后提交，
 * 服务端（时区可能与浏览器不同）对无时区标记的输入一律按 UTC 解析。空值返回 undefined。
 */
export function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** 截止时间短格式展示：同年「MM-DD HH:mm」，跨年带年份 */
export function formatDeadline(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hm = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const md = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return date.getFullYear() === new Date().getFullYear() ? `${md} ${hm}` : `${date.getFullYear()}-${md} ${hm}`;
}

/** 截止时间是否已过（相对当前时刻） */
export function deadlineOverdue(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

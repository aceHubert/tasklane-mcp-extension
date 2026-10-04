import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { BoardError } from './errors.js';
import { TASK_STATUSES, type Board, type TaskStatus, type WorkItem } from './work-item.js';

/**
 * 任务导出（只读能力）：按时间区间把看板任务渲染成一份 Markdown 报告并落盘。
 * 不修改任务、存储与执行链；相同区间重复导出按覆盖处理。
 */

/** 报告语言：跟随 UI 语言，缺省中文（仓库主语言） */
export const EXPORT_LANGS = ['zh', 'en'] as const;
export type ExportLang = (typeof EXPORT_LANGS)[number];

/** 导出范围：active=未归档 / archived=已归档 / all=全部（默认，含归档） */
export const EXPORT_SCOPES = ['active', 'archived', 'all'] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

/** 区间命中字段：创建/更新/归档任一落在区间内即导出，并在明细中写明命中来源 */
export type ExportMatchField = 'createdAt' | 'updatedAt' | 'archivedAt';

export interface ExportRange {
  /** 区间起点（含），ISO */
  start: string;
  /** 区间终点（含），ISO */
  end: string;
  /** 本地日期 YYYY-MM-DD，用于文件名与报告标题 */
  startDate: string;
  endDate: string;
  /** 本地时区偏移标签，如 UTC+08:00；报告内显式标注避免与 UTC 混淆 */
  timezone: string;
}

export interface ExportStats {
  total: number;
  byStatus: Record<TaskStatus, number>;
  /** 命中任务中已归档的数量 */
  archived: number;
  human: number;
  agent: number;
}

export interface ExportTaskEntry {
  task: WorkItem;
  matched: ExportMatchField[];
}

export interface ExportTasksInput {
  boardId?: string;
  start?: string;
  end?: string;
  scope?: ExportScope;
  path?: string;
  lang?: ExportLang;
}

export interface ExportResult {
  boardId: string;
  boardName: string;
  /** 报告文件绝对路径 */
  path: string;
  bytes: number;
  range: ExportRange;
  scope: ExportScope;
  stats: ExportStats;
  /** 完整报告文本（UI 预览与复制使用，与落盘内容一致） */
  markdown: string;
}

/** 描述在报告中的截断上限（字符），避免单条长描述撑爆汇报文档 */
export const EXPORT_DESCRIPTION_MAX = 1200;
/** 报告内展示的变更文件上限 */
const EXPORT_FILES_MAX = 10;
const MAX_BOUND_LENGTH = 40;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function assertExportScope(value: string): asserts value is ExportScope {
  if (!(EXPORT_SCOPES as readonly string[]).includes(value)) {
    throw new BoardError('VALIDATION', `非法 scope: ${value}，允许值: ${EXPORT_SCOPES.join(' / ')}`);
  }
}

export function assertExportLang(value: string): asserts value is ExportLang {
  if (!(EXPORT_LANGS as readonly string[]).includes(value)) {
    throw new BoardError('VALIDATION', `非法 lang: ${value}，允许值: ${EXPORT_LANGS.join(' / ')}`);
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function localDateString(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localDateTimeString(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${localDateString(d.getTime())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 本地时区偏移标签（UTC±HH:MM）；报告必须显式标注，避免读者把本地时间当成 UTC */
function timezoneLabel(ms: number): string {
  const offset = -new Date(ms).getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * 按自然月平移日期并把日号夹到目标月最后一天（3 月 31 日往前一个月 = 2 月 28/29 日），
 * 避免 JS 日期顺延把区间整体推后。
 */
function shiftMonths(day: { year: number; month: number; date: number }, delta: number) {
  const total = day.month + delta;
  const year = day.year + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDate = new Date(year, month + 1, 0).getDate();
  return { year, month, date: Math.min(day.date, lastDate) };
}

/**
 * 解析区间边界：'YYYY-MM-DD' 按本地自然日展开（start 取当日开始，end 取当日结束），
 * 其他字符串交给 Date.parse 按精确时刻处理。非法日期不静默顺延，直接报 VALIDATION。
 */
function parseBoundary(value: string, edge: 'start' | 'end', field: string): number {
  const text = value?.trim();
  if (!text) throw new BoardError('VALIDATION', `${field} 不能为空`);
  if (text.length > MAX_BOUND_LENGTH) {
    throw new BoardError('VALIDATION', `${field} 过长（最多 ${MAX_BOUND_LENGTH} 字符）: ${text}`);
  }
  const dateOnly = DATE_ONLY_PATTERN.exec(text);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const date = Number(dateOnly[3]);
    const at = edge === 'start'
      ? new Date(year, month - 1, date, 0, 0, 0, 0)
      : new Date(year, month - 1, date, 23, 59, 59, 999);
    // 2 月 30 日之类的非法日期在 JS 中会被顺延，必须回读校验后拒绝
    if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== date) {
      throw new BoardError('VALIDATION', `非法${field}日期: ${text}`);
    }
    return at.getTime();
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    throw new BoardError('VALIDATION', `无法解析${field}: ${text}（支持 YYYY-MM-DD 或 ISO 时间）`);
  }
  return ms;
}

/**
 * 解析导出区间：end 缺省为今天（本地）当天结束；start 缺省为 end 所在日期往前一个月。
 * 只给 start 且晚于今天时 end 仍取今天，最终 start > end 会明确报错而不是猜测用户意图。
 */
export function resolveExportRange(input: { start?: string; end?: string }, now: Date): ExportRange {
  if (!Number.isFinite(now.getTime())) throw new BoardError('VALIDATION', '当前时间不可用，无法解析默认区间');
  const defaultEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const endMs = input.end !== undefined && input.end !== null && String(input.end).trim() !== ''
    ? parseBoundary(String(input.end), 'end', 'end')
    : defaultEnd.getTime();
  let startMs: number;
  if (input.start !== undefined && input.start !== null && String(input.start).trim() !== '') {
    startMs = parseBoundary(String(input.start), 'start', 'start');
  } else {
    const endDay = new Date(endMs);
    const shifted = shiftMonths(
      { year: endDay.getFullYear(), month: endDay.getMonth(), date: endDay.getDate() },
      -1,
    );
    startMs = new Date(shifted.year, shifted.month, shifted.date, 0, 0, 0, 0).getTime();
  }
  if (startMs > endMs) {
    throw new BoardError(
      'VALIDATION',
      `区间非法：start(${new Date(startMs).toISOString()}) 晚于 end(${new Date(endMs).toISOString()})`,
    );
  }
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    startDate: localDateString(startMs),
    endDate: localDateString(endMs),
    timezone: timezoneLabel(startMs),
  };
}

/** 命中字段：任务创建/更新/归档时间落在闭区间内即返回非空来源 */
export function matchExportTask(task: WorkItem, range: ExportRange): ExportMatchField[] {
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  const matched: ExportMatchField[] = [];
  for (const field of ['createdAt', 'updatedAt', 'archivedAt'] as const) {
    const value = task[field];
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms >= start && ms <= end) matched.push(field);
  }
  return matched;
}

/** 区间筛选：按状态分组顺序排列，同状态内按更新时间倒序（最近有变动的在前） */
export function selectExportTasks(tasks: WorkItem[], range: ExportRange): ExportTaskEntry[] {
  return tasks
    .map((task) => ({ task, matched: matchExportTask(task, range) }))
    .filter((entry) => entry.matched.length > 0)
    .sort((a, b) => {
      const byUpdated = (b.task.updatedAt ?? '').localeCompare(a.task.updatedAt ?? '');
      return byUpdated !== 0 ? byUpdated : a.task.id.localeCompare(b.task.id);
    });
}

export function collectExportStats(entries: ExportTaskEntry[]): ExportStats {
  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  let archived = 0;
  let human = 0;
  let agent = 0;
  for (const { task } of entries) {
    byStatus[task.status] += 1;
    if (task.archivedAt) archived += 1;
    if (task.assignee === 'agent') agent += 1;
    else human += 1;
  }
  return { total: entries.length, byStatus, archived, human, agent };
}

interface ExportMessages {
  /** 标签与取值之间的分隔符（zh 全角冒号，en 半角冒号加空格） */
  colon: string;
  /** 括注（状态英文标识等）：zh 全角括号，en 半角括号 */
  parenOpen: string;
  parenClose: string;
  /** 并列项分隔符 */
  listJoiner: string;
  /** 同一行内的短句分隔符 */
  comma: string;
  title(board: string): string;
  boardLabel: string;
  repoLabel: string;
  noRepo: string;
  rangeLabel: string;
  rangeValue(range: ExportRange): string;
  scopeLabel: string;
  generatedAt: string;
  matchRuleLabel: string;
  matchRuleValue: string;
  summary: string;
  metric: string;
  count: string;
  total: string;
  archived: string;
  assignee: string;
  details: string;
  noTasks: string;
  status: string;
  priority: string;
  owner: string;
  created: string;
  updated: string;
  archivedAt: string;
  matched: string;
  matchedFields: Record<ExportMatchField, string>;
  branch: string;
  workspace: string;
  execution: string;
  started: string;
  activity: string;
  changes: string;
  filesCount(count: number): string;
  testLabel: string;
  testStatus: Record<'unknown' | 'passing' | 'failing', string>;
  description: string;
  truncated: string;
  statusLabels: Record<TaskStatus, string>;
  scopeLabels: Record<ExportScope, string>;
}

const messages: Record<ExportLang, ExportMessages> = {
  zh: {
    colon: '：',
    parenOpen: '（',
    parenClose: '）',
    listJoiner: '、',
    comma: '，',
    title: (board) => `TaskLane 任务导出 · ${board}`,
    boardLabel: '看板',
    repoLabel: '仓库',
    noRepo: '未绑定仓库',
    rangeLabel: '区间',
    rangeValue: (range) =>
      `${localDateTimeString(range.start)} — ${localDateTimeString(range.end)}（${range.timezone}，含边界）`,
    scopeLabel: '范围',
    generatedAt: '生成时间',
    matchRuleLabel: '命中口径',
    matchRuleValue: '创建、更新或归档时间落在区间内',
    summary: '概览',
    metric: '指标',
    count: '数量',
    total: '任务总数',
    archived: '其中已归档',
    assignee: '指派 Human / Agent',
    details: '任务明细',
    noTasks: '该区间没有匹配的任务。',
    status: '状态',
    priority: '优先级',
    owner: '负责人',
    created: '创建',
    updated: '更新',
    archivedAt: '归档',
    matched: '区间命中',
    matchedFields: { createdAt: '创建', updatedAt: '更新', archivedAt: '归档' },
    branch: '分支',
    workspace: '工作区',
    execution: '执行',
    started: '开始',
    activity: '摘要',
    changes: '变更',
    filesCount: (count) => `${count} 个文件`,
    testLabel: '测试',
    testStatus: { unknown: '未知', passing: '通过', failing: '失败' },
    description: '描述',
    truncated: '…（内容已截断）',
    statusLabels: { backlog: '待办', ready: '就绪', doing: '执行中', review: '待审查', done: '已完成' },
    scopeLabels: { all: '全部任务（含归档）', active: '仅未归档任务', archived: '仅已归档任务' },
  },
  en: {
    colon: ': ',
    parenOpen: ' (',
    parenClose: ')',
    listJoiner: ', ',
    comma: ', ',
    title: (board) => `TaskLane task export · ${board}`,
    boardLabel: 'Board',
    repoLabel: 'Repository',
    noRepo: 'No repository bound',
    rangeLabel: 'Range',
    rangeValue: (range) =>
      `${localDateTimeString(range.start)} — ${localDateTimeString(range.end)} (${range.timezone}, boundaries inclusive)`,
    scopeLabel: 'Scope',
    generatedAt: 'Generated at',
    matchRuleLabel: 'Match rule',
    matchRuleValue: 'Created, updated, or archived within the range',
    summary: 'Summary',
    metric: 'Metric',
    count: 'Count',
    total: 'Total tasks',
    archived: 'Of which archived',
    assignee: 'Assigned Human / Agent',
    details: 'Task details',
    noTasks: 'No tasks matched this range.',
    status: 'Status',
    priority: 'Priority',
    owner: 'Assignee',
    created: 'Created',
    updated: 'Updated',
    archivedAt: 'Archived',
    matched: 'Matched on',
    matchedFields: { createdAt: 'created', updatedAt: 'updated', archivedAt: 'archived' },
    branch: 'Branch',
    workspace: 'Workspace',
    execution: 'Execution',
    started: 'Started',
    activity: 'Activity',
    changes: 'Changes',
    filesCount: (count) => `${count} file${count === 1 ? '' : 's'}`,
    testLabel: 'Tests',
    testStatus: { unknown: 'unknown', passing: 'passing', failing: 'failing' },
    description: 'Description',
    truncated: '… (truncated)',
    statusLabels: { backlog: 'Backlog', ready: 'Ready', doing: 'Doing', review: 'Review', done: 'Done' },
    scopeLabels: { all: 'All tasks (incl. archived)', active: 'Active tasks only', archived: 'Archived tasks only' },
  },
};

/** 标题行内联：压缩换行与多余空白，避免破坏 Markdown 标题结构 */
function inlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** 描述按引用块展示：逐行加 '> ' 前缀，超长截断并显式标注 */
function quoteDescription(description: string, m: ExportMessages): string[] {
  const text = description.replace(/\r\n?/g, '\n').trim();
  const truncated = text.length > EXPORT_DESCRIPTION_MAX;
  const body = truncated ? `${text.slice(0, EXPORT_DESCRIPTION_MAX)}${m.truncated}` : text;
  return body.split('\n').map((line) => `> ${line}`.trimEnd());
}

function renderTask(entry: ExportTaskEntry, m: ExportMessages): string[] {
  const { task, matched } = entry;
  const lines: string[] = [`#### \`${task.id}\` ${inlineText(task.title)}`, ''];
  lines.push(`- ${m.status}${m.colon}${m.statusLabels[task.status]}${m.parenOpen}${task.status}${m.parenClose} · ${m.priority}${m.colon}${task.priority} · ${m.owner}${m.colon}${task.assignee}`);
  const times = [`${m.created}${m.colon}${localDateTimeString(task.createdAt)}`, `${m.updated}${m.colon}${localDateTimeString(task.updatedAt)}`];
  if (task.archivedAt) times.push(`${m.archivedAt}${m.colon}${localDateTimeString(task.archivedAt)}`);
  lines.push(`- ${times.join(' · ')}`);
  lines.push(`- ${m.matched}${m.colon}${matched.map((field) => m.matchedFields[field]).join(m.listJoiner)}`);

  const git: string[] = [];
  if (task.branch) git.push(`${m.branch}${m.colon}\`${inlineText(task.branch)}\``);
  if (task.worktreePath) git.push(`${m.workspace}${m.colon}\`${inlineText(task.worktreePath)}\``);
  if (git.length > 0) lines.push(`- ${git.join(' · ')}`);

  const execution = task.execution;
  const execParts: string[] = [execution.state];
  if (execution.activity) execParts.push(`${m.activity}${m.colon}${inlineText(execution.activity)}`);
  if (execution.startedAt) execParts.push(`${m.started}${m.colon}${localDateTimeString(execution.startedAt)}`);
  lines.push(`- ${m.execution}${m.colon}${execParts.join(' · ')}`);

  if (task.changes) {
    const changes = task.changes;
    const stat = `+${changes.additions} / −${changes.deletions}`;
    lines.push(
      `- ${m.changes}${m.colon}${m.filesCount(changes.filesChanged)}${m.comma}${stat}${m.comma}${m.testLabel} ${m.testStatus[changes.testStatus]}`,
    );
    for (const file of changes.files.slice(0, EXPORT_FILES_MAX)) {
      lines.push(`  - \`${inlineText(file.name)}\` +${file.added} −${file.removed}`);
    }
  }

  if (task.description?.trim()) {
    lines.push('', `${m.description}${m.colon}`, '');
    lines.push(...quoteDescription(task.description, m));
  }
  lines.push('');
  return lines;
}

export function renderTaskExportMarkdown(input: {
  board: Board;
  entries: ExportTaskEntry[];
  range: ExportRange;
  scope: ExportScope;
  generatedAt: string;
  lang?: ExportLang;
}): string {
  const lang = input.lang ?? 'zh';
  assertExportLang(lang);
  const m = messages[lang];
  const stats = collectExportStats(input.entries);
  const lines: string[] = [];

  lines.push(`# ${m.title(inlineText(input.board.name))}`, '');
  lines.push(`- ${m.boardLabel}${m.colon}\`${inlineText(input.board.name)}\`${m.parenOpen}\`${input.board.id}\`${m.parenClose}`);
  lines.push(`- ${m.repoLabel}${m.colon}${input.board.repo ? `\`${inlineText(input.board.repo)}\`` : m.noRepo}`);
  lines.push(`- ${m.rangeLabel}${m.colon}${m.rangeValue(input.range)}`);
  lines.push(`- ${m.scopeLabel}${m.colon}${m.scopeLabels[input.scope]}`);
  lines.push(`- ${m.generatedAt}${m.colon}${localDateTimeString(input.generatedAt)}`);
  lines.push(`- ${m.matchRuleLabel}${m.colon}${m.matchRuleValue}`);
  lines.push('');
  lines.push(`## ${m.summary}`, '');
  lines.push(`| ${m.metric} | ${m.count} |`, '| --- | --- |');
  lines.push(`| ${m.total} | ${stats.total} |`);
  for (const status of TASK_STATUSES) {
    lines.push(`| ${m.statusLabels[status]}${m.parenOpen}${status}${m.parenClose} | ${stats.byStatus[status]} |`);
  }
  lines.push(`| ${m.archived} | ${stats.archived} |`);
  lines.push(`| ${m.assignee} | ${stats.human} / ${stats.agent} |`);
  lines.push('');
  lines.push(`## ${m.details}`, '');

  if (input.entries.length === 0) {
    lines.push(m.noTasks, '');
    return `${lines.join('\n').trimEnd()}\n`;
  }

  for (const status of TASK_STATUSES) {
    const group = input.entries.filter((entry) => entry.task.status === status);
    if (group.length === 0) continue;
    lines.push(`### ${m.statusLabels[status]}${m.parenOpen}${status}${m.parenClose} · ${group.length}`, '');
    for (const entry of group) lines.push(...renderTask(entry, m));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 默认导出目录：数据目录下的 exports/（TASKLANE_HOME 优先），不污染用户仓库 */
export function defaultExportDir(): string {
  const home = process.env.TASKLANE_HOME;
  return home ? path.join(home, 'exports') : path.join(homedir(), '.tasklane', 'exports');
}

/**
 * 默认文件名：看板名清洗后 + 区间本地日期 + 生成时间戳（yyyyMMdd-HHmmss）。
 * 完整时间戳让同区间的重复/并发导出各得一份文件，不互相覆盖；
 * 同一秒内的极端冲突仍按覆盖处理（原子写入）。
 */
export function defaultExportFileName(board: Board, range: ExportRange, generatedAt: Date = new Date()): string {
  const slug = inlineText(board.name)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${generatedAt.getFullYear()}${pad(generatedAt.getMonth() + 1)}${pad(generatedAt.getDate())}` +
    `-${pad(generatedAt.getHours())}${pad(generatedAt.getMinutes())}${pad(generatedAt.getSeconds())}`;
  return `${slug || 'board'}-${range.startDate}_${range.endDate}-${stamp}.md`;
}

/**
 * 解析报告落盘路径：显式 path 必须是绝对路径，指向已存在目录时补默认文件名，
 * 缺少 .md 后缀时补全；省略时写入默认导出目录。
 */
export function resolveExportFilePath(input: {
  path?: string;
  board: Board;
  range: ExportRange;
  generatedAt?: Date;
}): string {
  const name = defaultExportFileName(input.board, input.range, input.generatedAt);
  const raw = input.path?.trim();
  if (!raw) return path.join(defaultExportDir(), name);
  if (!path.isAbsolute(raw)) {
    throw new BoardError('VALIDATION', `path 必须是绝对路径: ${raw}`);
  }
  const target = raw.endsWith(path.sep) || (existsSync(raw) && statSync(raw).isDirectory())
    ? path.join(raw, name)
    : raw;
  return target.toLowerCase().endsWith('.md') ? target : `${target}.md`;
}

/** 原子写入：同目录临时文件 + rename，避免并发导出留下半截报告 */
export function writeExportFile(filePath: string, content: string): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    throw new BoardError(
      'STORE_ERROR',
      `导出文件写入失败: ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

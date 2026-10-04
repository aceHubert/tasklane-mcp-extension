import path from 'node:path';
import {
  assertAssignee,
  assertPriority,
  assertStatus,
  normalizeTaskId,
  TASK_STATUSES,
  type Assignee,
  type Board,
  type BoardSummary,
  type ExecutionState,
  type Priority,
  type TaskStatus,
  type WorkItem,
  type RequestExecutionInput,
  type ExecutionDeliveryInput,
  type ExecutionRecoveryInput,
  type RequestExecutionRecoveryInput,
  type ClaimExecutionInput,
  type BindExecutionInput,
  type ReportExecutionInput,
} from './work-item.js';
import { BoardError } from './errors.js';
import type { BoardStore, SessionEvent, TaskFilter } from './board-store.js';
import {
  assertExportLang,
  assertExportScope,
  collectExportStats,
  renderTaskExportMarkdown,
  resolveExportFilePath,
  resolveExportRange,
  selectExportTasks,
  writeExportFile,
  type ExportResult,
  type ExportTasksInput,
} from './export.js';
import { GitService } from './git.js';
import { SessionRegistry } from './session.js';
import { NativeExecution } from './native-execution.js';

/** 允许的状态流转：前向流转 + 一步回退（返工场景） */
const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ['ready', 'doing'],
  ready: ['doing', 'backlog'],
  doing: ['review', 'ready'],
  review: ['done', 'doing'],
  done: ['review'],
};

export interface ExecutionPatch {
  state?: ExecutionState;
  activity?: string;
}

export class BoardEngine {
  private readonly sessions: SessionRegistry;
  private readonly nowIso: () => string;
  private readonly nativeExecution: NativeExecution;
  /**
   * 任务级串行队列：assign / move / update 在同一任务上按序执行，
   * 防止 git 等异步间隙中的读-改-写互相覆盖（并发更新丢失）。
   */
  private readonly taskLocks = new Map<string, Promise<unknown>>();

  constructor(
    private store: BoardStore,
    private git = new GitService(),
    now: () => Date = () => new Date(),
  ) {
    this.sessions = new SessionRegistry(store, now);
    this.nowIso = () => now().toISOString();
    this.nativeExecution = new NativeExecution(store, git, this.nowIso);
  }

  private lockTask<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.taskLocks.get(taskId) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.catch(() => undefined);
    this.taskLocks.set(taskId, tail);
    void tail.then(() => {
      if (this.taskLocks.get(taskId) === tail) this.taskLocks.delete(taskId);
    });
    return result;
  }

  /**
   * 解析任务操作的看板：显式传入时校验存在；省略且只有一个看板时自动解析；
   * 多看板省略必须报错，不得悄悄操作第一个看板（执行计划 §4.2）。
   */
  private resolveBoardId(boardId?: string): string {
    const boards = this.store.boards;
    if (boardId !== undefined) {
      this.requireBoard(boardId);
      return boardId;
    }
    if (boards.length === 1) return boards[0].id;
    throw new BoardError(
      'VALIDATION',
      `存在 ${boards.length} 个看板，必须通过 boardId 指定目标（board_list 可查看全部）`,
    );
  }

  private requireBoard(id: string) {
    const board = this.store.getBoard(id);
    if (!board) throw new BoardError('BOARD_NOT_FOUND', `看板不存在: ${id}`);
    return board;
  }

  /** 跨看板写入校验：任务不属于传入看板时拒绝，不回退到其他看板 */
  private assertBoardMatch(task: WorkItem, boardId?: string): void {
    if (boardId === undefined) return;
    this.requireBoard(boardId);
    if (task.boardId !== boardId) {
      throw new BoardError(
        'BOARD_MISMATCH',
        `任务 ${task.id} 属于看板 ${task.boardId}，不属于 ${boardId}`,
      );
    }
  }

  /**
   * 注册已有本地 Git 仓库为新看板：先校验身份和基线（空仓库允许当前未提交分支），
   * 回填旧看板缺失的仓库身份键，再由存储在锁内去重写入。
   * 同一仓库（含子目录/符号链接/worktree 视角）重复注册幂等返回已有看板。
   */
  async registerBoard(input: {
    repo: string;
    name?: string;
    baseBranch?: string;
  }): Promise<Board> {
    const repo = input.repo?.trim();
    if (!repo) throw new BoardError('VALIDATION', 'repo 不能为空');
    const baseBranch = input.baseBranch?.trim() || 'main';
    const validation = await this.git.validateRepoForBoard(repo, baseBranch);
    const name = input.name?.trim() || path.basename(validation.root);

    await this.backfillBoardRepoKeys();
    const { board, created } = this.store.registerBoard({
      repoKey: validation.repoKey,
      repo: validation.root,
      name,
      baseBranch,
    });
    if (!created) {
      console.error(
        `[tasklane] 仓库已注册为看板 ${board.id}（${board.name}），返回既有看板`,
      );
    }
    return board;
  }

  /**
   * 项目模式解析（open_tasklane）：先按仓库身份匹配已登记看板（匹配成功直接返回，
   * 不因传入 baseBranch 无效而拒绝已登记仓库）；未登记时才走完整注册校验
   * （baseBranch 缺省 main；空仓库允许当前未提交分支，其他不存在的分支仍报错）。
   * 与 registerBoard 的区别：后者始终全量校验（显式注册时用户指定的基线错误应报错）。
   */
  async resolveProjectBoard(input: { repo: string; baseBranch?: string }): Promise<Board> {
    const repo = input.repo?.trim();
    if (!repo) throw new BoardError('VALIDATION', 'repo 不能为空');
    const identity = await this.git.identifyRepo(repo);
    await this.backfillBoardRepoKeys();
    // 身份匹配谓词与存储 registerBoard 一致：repoKey 优先，旧看板路径兜底
    const existing = this.store.boards.find(
      (b) => b.repoKey === identity.repoKey || (b.repo != null && b.repo === identity.root),
    );
    if (existing) return structuredClone(existing);
    // 未登记：校验已存在的基线或空仓库当前未提交分支，缺省 main，不接受任意未来分支。
    const baseBranch = input.baseBranch?.trim() || 'main';
    const validation = await this.git.validateRepoForBoard(repo, baseBranch);
    const { board } = this.store.registerBoard({
      repoKey: validation.repoKey,
      repo: validation.root,
      name: path.basename(validation.root),
      baseBranch,
    });
    return board;
  }

  /** 为缺少仓库身份键的旧看板回填 repoKey（一次 Git 调用，锁内条件写入） */
  private async backfillBoardRepoKeys(): Promise<void> {
    for (const board of this.store.boards) {
      if (board.repoKey || !board.repo) continue;
      try {
        // 只识别身份，不校验基线：旧看板基线漂移不应阻止身份回填
        const repoKey = await this.git.identifyRepo(board.repo)
          .then((v) => v.repoKey)
          .catch(() => null);
        if (!repoKey) continue;
        this.store.mutateBoard(board.id, (b) =>
          b.repoKey ? b : { ...b, repoKey },
        );
      } catch {
        /* 旧看板仓库已不可用：保留原状，注册去重退化为路径匹配 */
      }
    }
  }

  boardList(): BoardSummary[] {
    // 单次热文件快照保证活跃计数与归档计数属于同一提交，不读取冷文件。
    const { boards, tasks, archivedCounts } = this.store.getActiveSnapshot();
    return boards.map((board) => {
      const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
      let total = 0;
      const archivedCount = archivedCounts[board.id] ?? 0;
      for (const t of tasks) {
        if (t.boardId !== board.id) continue;
        counts[t.status] += 1;
        total += 1;
      }
      return { ...board, counts, total, archivedCount };
    });
  }

  listTasks(filter?: TaskFilter): WorkItem[] {
    // 业务层默认口径：未显式指定 archive 时按 active（归档任务从日常看板移出）。
    // 需要完整数据的内部处理直接使用 store（undefined 不约束）。
    const resolved: TaskFilter = { ...filter, archive: filter?.archive ?? 'active' };
    if (resolved.boardId !== undefined) {
      this.requireBoard(resolved.boardId);
      return this.store.listTasks(resolved);
    }
    // 省略 boardId：单看板自动解析；多看板必须显式指定，不得混出全部任务
    const boards = this.store.boards;
    if (boards.length === 1) {
      return this.store.listTasks({ ...resolved, boardId: boards[0].id });
    }
    throw new BoardError(
      'VALIDATION',
      `存在 ${boards.length} 个看板，task_list 必须通过 boardId 指定目标（board_list 可查看全部）`,
    );
  }

  getTask(id: string, boardId?: string): WorkItem {
    const task = this.requireTask(id);
    this.assertBoardMatch(task, boardId);
    return task;
  }

  getTaskWithTimeline(id: string, boardId?: string): { task: WorkItem; timeline: SessionEvent[] } {
    const task = this.requireTask(id);
    this.assertBoardMatch(task, boardId);
    const record = this.store.getSession(task.id);
    return { task, timeline: record ? record.events.slice(-12) : [] };
  }

  async createTask(input: {
    title: string;
    boardId?: string;
    description?: string;
    priority?: Priority;
    status?: TaskStatus;
  }): Promise<WorkItem> {
    const title = input.title?.trim();
    if (!title) throw new BoardError('VALIDATION', 'title 不能为空');
    const boardId = this.resolveBoardId(input.boardId);
    const priority = input.priority ?? 'P2';
    assertPriority(priority);
    const status = input.status ?? 'backlog';
    assertStatus(status);

    const now = this.nowIso();
    const task = this.store.createTask({
      boardId,
      title,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      status,
      priority,
      assignee: 'human',
      execution: { state: 'idle', updatedAt: now },
      createdAt: now,
      updatedAt: now,
    });
    this.sessions.record(task.id, 'created', `${task.id} created in ${status}`);
    return task;
  }

  async updateTask(input: {
    id: string;
    boardId?: string;
    title?: string;
    description?: string;
    priority?: Priority;
    execution?: ExecutionPatch;
  }): Promise<WorkItem> {
    const id = normalizeTaskId(input.id);
    this.assertBoardMatch(this.requireTask(id), input.boardId);
    const now = this.nowIso();
    const next = this.store.mutateTask(id, (task) => {
      this.assertBoardMatch(task, input.boardId);
      this.assertNotArchived(task);
      const n = structuredClone(task);

      if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title) throw new BoardError('VALIDATION', 'title 不能为空');
        n.title = title;
      }
      if (input.description !== undefined) {
        n.description = input.description.trim() || undefined;
      }
      if (input.priority !== undefined) {
        assertPriority(input.priority);
        n.priority = input.priority;
      }

      if (input.execution !== undefined) {
        throw new BoardError('EXECUTION_REPORT_REQUIRED', '执行状态必须通过 task_execution_report 关联真实聊天和本轮 runId');
      }

      n.updatedAt = now;
      return n;
    });

    return next;
  }

  async moveTask(id: string, status: string, boardId?: string): Promise<WorkItem> {
    assertStatus(status);
    const taskId = normalizeTaskId(id);
    return this.lockTask(taskId, async () => {
      const current = this.requireTask(taskId);
      this.assertBoardMatch(current, boardId);

      const now = this.nowIso();
      let from = current.status;
      // 业务状态与真实执行回执分离，手动流转不证明 Agent 启动或完成。
      // 流转校验必须在事务内基于磁盘最新状态执行：taskLocks 只约束本进程，
      // 事务外的旧快照会让跨进程并发下的非法流转（如 done → doing）绕过校验。
      const moved = this.store.mutateTask(taskId, (task) => {
        this.assertBoardMatch(task, boardId);
        this.assertNotArchived(task);
        this.assertTransition(task.status, status);
        from = task.status;
        const n = structuredClone(task);
        n.status = status;
        n.updatedAt = now;

        return n;
      });

      this.sessions.record(taskId, 'moved', `${from} → ${status}`);

      // 第二阶段：diff 摘要是异步 git 操作；完成后只合并 changes 字段，
      // 不回写整份旧副本，期间的其他并发更新（如 agent 自报）得以保留
      if (status === 'review') {
        const changes = await this.refreshChanges(moved);
        if (changes) {
          return this.store.mutateTask(taskId, (task) => ({ ...structuredClone(task), changes }));
        }
      }
      return moved;
    });
  }

  async assignTask(id: string, assignee: string, boardId?: string): Promise<WorkItem> {
    assertAssignee(assignee);
    const now = this.nowIso();
    const { task } = this.store.mutateTaskWithEvent(normalizeTaskId(id), (current) => {
      this.assertBoardMatch(current, boardId);
      this.assertNotArchived(current);
      if (current.assignee === assignee) return { task: current, events: [] };
      current.assignee = assignee;
      // 改派不代表停止；保留真实运行、旧内部标识和已有 Git 工作区。
      if (current.execution.state === 'idle' || current.execution.state === 'assigned') {
        current.execution = { ...current.execution, state: assignee === 'agent' ? 'assigned' : 'idle', updatedAt: now };
      }
      current.updatedAt = now;
      return { task: current, events: [{ at: now, kind: 'assigned', detail: `assigned to ${assignee}` }] };
    });
    return task;
  }

  requestExecution(input: RequestExecutionInput) {
    return this.nativeExecution.request(input);
  }

  requestExecutionRecovery(input: RequestExecutionRecoveryInput) {
    return this.nativeExecution.requestRecovery(input);
  }

  recoverExecution(input: ExecutionRecoveryInput) {
    return this.nativeExecution.recover(input);
  }

  markExecutionDelivery(input: ExecutionDeliveryInput) {
    return this.nativeExecution.delivery(input);
  }

  claimExecution(input: ClaimExecutionInput) {
    return this.nativeExecution.claim(input);
  }

  bindExecution(input: BindExecutionInput) {
    return this.nativeExecution.bind(input);
  }

  reportExecution(input: ReportExecutionInput) {
    return this.nativeExecution.report(input);
  }

  /**
   * 删除任务（唯一硬删除入口，仅 backlog）：任务与执行时间线/会话记录一并移除，不可恢复。
   * 守卫在任务锁内按磁盘最新状态执行：非 backlog、已绑定原生聊天或执行态已推进
   * （进入请求/回执链）的任务一律拒绝，防止删掉已进入执行链的任务造成记录断链；
   * 已完成任务请走归档留痕，不走删除。
   */
  async deleteTask(id: string, boardId?: string): Promise<string> {
    const taskId = normalizeTaskId(id);
    return this.lockTask(taskId, async () => {
      const task = this.requireTask(taskId);
      this.assertBoardMatch(task, boardId);
      if (task.status !== 'backlog') {
        throw new BoardError('VALIDATION', `仅 backlog 状态的任务可删除，当前状态: ${task.status}；已完成任务请使用归档`);
      }
      if (task.executionBinding || task.executionRequests?.some((request) => request.result)) {
        throw new BoardError('VALIDATION', '任务已绑定或保存原生聊天结果，不能删除');
      }
      if (task.execution.state !== 'idle' && task.execution.state !== 'assigned') {
        throw new BoardError('VALIDATION', `任务执行已推进（${task.execution.state}），不能删除`);
      }
      if (!this.store.deleteTask(taskId)) {
        throw new BoardError('TASK_NOT_FOUND', `任务不存在: ${taskId}`);
      }
      return taskId;
    });
  }

  /**
   * 导出看板任务为 Markdown 报告（只读，不改任务、存储版本与执行链）：
   * 区间缺省为「今天往前一个月」（本地自然日），命中口径为创建/更新/归档任一落在区间内；
   * scope 缺省 all（含归档，汇报需覆盖已完成归档项）。默认写入数据目录 exports/，
   * 可用绝对路径指定位置；同名文件按覆盖处理（重新生成即预期覆盖）。
   */
  async exportTasks(input: ExportTasksInput): Promise<ExportResult> {
    const boardId = this.resolveBoardId(input.boardId);
    const board = this.requireBoard(boardId);
    const scope = input.scope ?? 'all';
    assertExportScope(scope);
    const lang = input.lang ?? 'zh';
    assertExportLang(lang);
    const nowIso = this.nowIso();
    const range = resolveExportRange({ start: input.start, end: input.end }, new Date(nowIso));
    const entries = selectExportTasks(this.store.listTasks({ boardId, archive: scope }), range);
    const stats = collectExportStats(entries);
    const markdown = renderTaskExportMarkdown({ board, entries, range, scope, generatedAt: nowIso, lang });
    const filePath = resolveExportFilePath({ path: input.path, board, range, generatedAt: new Date(nowIso) });
    writeExportFile(filePath, markdown);
    return {
      boardId,
      boardName: board.name,
      path: filePath,
      bytes: Buffer.byteLength(markdown, 'utf8'),
      range,
      scope,
      stats,
      markdown,
    };
  }

  /**
   * 归档单条已完成任务：设置 archivedAt（保持 status: done），任务与事件在
   * 同一持久化事务提交。重复归档幂等（changed=false，不更新时间与时间线）。
   * 任务锁顺序与 move/assign 一致（taskLocks → 存储文件锁）。
   */
  async archiveTask(id: string, boardId?: string): Promise<{ task: WorkItem; changed: boolean }> {
    const taskId = normalizeTaskId(id);
    return this.lockTask(taskId, async () => {
      this.assertBoardMatch(this.requireTask(taskId), boardId);
      const now = this.nowIso();
      const { task, events } = this.store.moveToArchive(taskId, (cur) => {
        if (cur.archivedAt) return { task: cur, events: [] };
        if (cur.status !== 'done') {
          throw new BoardError(
            'VALIDATION',
            `仅允许归档 done 任务，${cur.id} 当前为 ${cur.status}（先流转到 done 再归档）`,
          );
        }
        const n = structuredClone(cur);
        n.archivedAt = now;
        n.updatedAt = now;
        return { task: n, events: [{ at: now, kind: 'archived', detail: 'archived from done' }] };
      });
      return { task, changed: events.length > 0 };
    });
  }

  /**
   * 恢复归档任务到 Done 列：移除 archivedAt 并更新 updatedAt，内容、执行
   * 记录与 Git 绑定保持不变。重复恢复幂等（changed=false）。
   */
  async restoreTask(id: string, boardId?: string): Promise<{ task: WorkItem; changed: boolean }> {
    const taskId = normalizeTaskId(id);
    return this.lockTask(taskId, async () => {
      this.assertBoardMatch(this.requireTask(taskId), boardId);
      const now = this.nowIso();
      const { task, events } = this.store.restoreFromArchive(taskId, (cur) => {
        if (!cur.archivedAt) return { task: cur, events: [] };
        const n = structuredClone(cur);
        delete n.archivedAt;
        n.updatedAt = now;
        return { task: n, events: [{ at: now, kind: 'restored', detail: 'restored to done' }] };
      });
      return { task, changed: events.length > 0 };
    });
  }

  /**
   * 批量归档指定看板全部未归档 done 任务：目标集合在存储锁内基于磁盘最新
   * 状态选取（并发回退到 review 的任务不会被归档），所有任务修改与事件
   * 单次原子提交，失败无部分写入。boardId 必填，不提供跨看板隐式行为。
   * 锁顺序：批量只持存储文件锁（无异步间隙），与单任务 taskLocks → 文件锁
   * 的顺序不构成环。
   */
  async archiveDoneTasks(boardId: string): Promise<{ archivedCount: number; archivedIds: string[] }> {
    this.requireBoard(boardId);
    const now = this.nowIso();
    const archived = this.store.moveTasksToArchive(boardId, (t) => {
      if (t.boardId !== boardId || t.status !== 'done' || t.archivedAt) return null;
      const n = structuredClone(t);
      n.archivedAt = now;
      n.updatedAt = now;
      return { task: n, events: [{ at: now, kind: 'archived', detail: 'archived with done batch' }] };
    });
    return {
      archivedCount: archived.length,
      archivedIds: archived.map((t) => t.id).sort(),
    };
  }

  /**
   * 归档任务只读守卫：常规编辑/流转/指派必须先恢复。放在 mutateTask 事务
   * 函数内基于磁盘最新状态执行——跨进程旧快照与并发间隙都无法绕过。
   */
  private assertNotArchived(task: WorkItem): void {
    if (task.archivedAt) {
      throw new BoardError(
        'TASK_ARCHIVED',
        `任务 ${task.id} 已归档（${task.archivedAt}），请先恢复（task_restore）后再修改`,
      );
    }
  }

  private assertTransition(from: TaskStatus, to: TaskStatus): void {
    if (from === to) {
      throw new BoardError('VALIDATION', `任务已在 ${to} 状态`);
    }
    const allowed = ALLOWED_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new BoardError(
        'INVALID_TRANSITION',
        `不允许 ${from} → ${to}，允许的目标状态: ${allowed.join(' / ')}`,
        { from, to, allowed },
      );
    }
  }

  private async refreshChanges(task: WorkItem) {
    // diff 锚定在任务所属看板的仓库与基线，不能读取其他仓库
    const board = this.store.getBoard(task.boardId);
    if (!this.git.enabled || !board?.repo || !task.worktreePath || !task.branch) return undefined;
    try {
      // 不直接信任落盘的 worktreePath：diff 前重新核验仓库身份与任务分支，
      // 目录被重绑成普通目录/其他仓库的工作区后宁可降级，也不读错数据
      await this.git.assertWorktreeMatches(task.worktreePath, board.repo, task.branch);
      return await this.git.diffSummary(task.worktreePath, task.baseBranch || board.baseBranch || 'main');
    } catch (err) {
      console.error(
        `[tasklane] diff summary degraded for ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  }

  private requireTask(id: string): WorkItem {
    const task = this.store.getTask(normalizeTaskId(id));
    if (!task) throw new BoardError('TASK_NOT_FOUND', `任务不存在: ${normalizeTaskId(id)}`);
    return task;
  }
}

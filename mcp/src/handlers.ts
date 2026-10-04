import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  BoardError,
  type Assignee,
  type BindExecutionInput,
  type BoardEngine,
  type ClaimExecutionInput,
  type ExecutionDeliveryInput,
  type ExecutionRecoveryInput,
  type RequestExecutionRecoveryInput,
  type ExecutionState,
  type ExportTasksInput,
  type ModelCatalogService,
  type Priority,
  type ReportExecutionInput,
  type RequestExecutionInput,
  type TaskStatus,
} from '@tasklane/core';

/**
 * 纯 handler 层：只依赖 BoardEngine，不依赖 MCP SDK，可直接被单测调用。
 * 人（Sidebar UI）与编码 agent 调用的是完全相同的这组入口。
 * 多看板规则：列表/创建省略 boardId 仅在单看板时自动解析；按任务 ID 的
 * 读取/修改省略 boardId 时用任务自身归属，传入错误归属直接拒绝。
 */
export async function boardList(engine: BoardEngine) {
  return { boards: engine.boardList() };
}

export async function boardCreate(
  engine: BoardEngine,
  args: { repo: string; name?: string; baseBranch?: string },
) {
  return { board: await engine.registerBoard(args) };
}

export async function taskList(
  engine: BoardEngine,
  args: {
    boardId?: string;
    status?: TaskStatus;
    assignee?: Assignee;
    priority?: Priority;
    archive?: 'active' | 'archived' | 'all';
  },
) {
  return { tasks: engine.listTasks(args) };
}

export async function taskGet(engine: BoardEngine, args: { id: string; boardId?: string }) {
  return engine.getTaskWithTimeline(args.id, args.boardId);
}

export async function taskCreate(
  engine: BoardEngine,
  args: {
    title: string;
    boardId?: string;
    description?: string;
    priority?: Priority;
    status?: TaskStatus;
  },
) {
  return { task: await engine.createTask(args) };
}

export async function taskUpdate(
  engine: BoardEngine,
  args: {
    id: string;
    boardId?: string;
    title?: string;
    description?: string;
    priority?: Priority;
    execution?: { state?: ExecutionState; activity?: string };
  },
) {
  const { id, boardId, ...rest } = args;
  return { task: await engine.updateTask({ id, boardId, ...rest }) };
}

export async function taskMove(
  engine: BoardEngine,
  args: { id: string; status: TaskStatus; boardId?: string },
) {
  return { task: await engine.moveTask(args.id, args.status, args.boardId) };
}

export async function taskAssign(
  engine: BoardEngine,
  args: { id: string; assignee: Assignee; boardId?: string },
) {
  return { task: await engine.assignTask(args.id, args.assignee, args.boardId) };
}

// 关联、归属、归档与 Git 校验均由核心事务负责；handler 不创建执行器或工作区。
export async function taskExecutionRequest(engine: BoardEngine, args: RequestExecutionInput) {
  return engine.requestExecution(args);
}
export async function taskExecutionRecoveryRequest(engine: BoardEngine, args: RequestExecutionRecoveryInput) {
  return engine.requestExecutionRecovery(args);
}

export async function taskExecutionRecover(engine: BoardEngine, args: ExecutionRecoveryInput) {
  return engine.recoverExecution(args);
}

export async function taskExecutionDelivery(engine: BoardEngine, args: ExecutionDeliveryInput) {
  return engine.markExecutionDelivery(args);
}

export async function taskExecutionClaim(engine: BoardEngine, args: ClaimExecutionInput) {
  return engine.claimExecution(args);
}

export async function taskExecutionBind(engine: BoardEngine, args: BindExecutionInput) {
  return engine.bindExecution(args);
}

export async function taskExecutionReport(engine: BoardEngine, args: ReportExecutionInput) {
  return engine.reportExecution(args);
}

/** 只读查询宿主模型目录：UI「指定模型」候选数据源，不是执行入口或兜底执行器 */
export async function modelList(catalog: ModelCatalogService) {
  return catalog.listModels();
}

/** 删除 backlog 任务（硬删除，级联清理时间线）；非 backlog 或已进入执行链一律拒绝 */
export async function taskDelete(engine: BoardEngine, args: { id: string; boardId?: string }) {
  const id = await engine.deleteTask(args.id, args.boardId);
  return { id, deleted: true };
}

/** 归档单个 done 任务：返回任务与是否实际变更（重复归档 changed=false） */
export async function taskArchive(engine: BoardEngine, args: { id: string; boardId?: string }) {
  return engine.archiveTask(args.id, args.boardId);
}

/** 恢复单个归档任务到 Done：返回任务与是否实际变更（重复恢复 changed=false） */
export async function taskRestore(engine: BoardEngine, args: { id: string; boardId?: string }) {
  return engine.restoreTask(args.id, args.boardId);
}

/** 批量归档指定看板全部未归档 done 任务：boardId 必填，返回实际归档数量与 ID */
export async function taskArchiveDone(engine: BoardEngine, args: { boardId: string }) {
  return engine.archiveDoneTasks(args.boardId);
}

/**
 * 导出看板任务为 Markdown 报告（只读）：区间缺省「今天往前一个月」，
 * 默认写入数据目录 exports/ 并返回 path 与完整 Markdown；不改任务与存储。
 */
export async function taskExport(engine: BoardEngine, args: ExportTasksInput) {
  return engine.exportTasks(args);
}

/**
 * 文件夹选择器后端（只读、单层）：列出目录下可见子目录，标记 Git 仓库及其默认基线分支
 * （优先 main、其次 master；无提交仓库使用当前分支，其余默认 main）。
 * 供添加仓库表单的浏览模式使用；隐藏目录（.worktrees 等）与不可读项直接跳过。
 */
export async function dirList(_engine: BoardEngine, args: { path?: string }) {
  const dir = path.resolve(args.path?.trim() || homedir());
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    throw new BoardError(
      'VALIDATION',
      `无法读取目录: ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const entries = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue; // 权限/竞态不可读的条目不展示
    }
    entries.push({ name, path: full, isRepo: existsSync(path.join(full, '.git')), baseBranch: detectBaseBranch(full) });
  }
  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, home: homedir(), entries };
}

/** 解析仓库 gitdir：主仓库即 .git；worktree 从 gitdir 指针 + commondir 归位到主仓库（refs 共享） */
function resolveGitDir(repoPath: string): string | null {
  const dotGit = path.join(repoPath, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = /^gitdir:\s*(.+)$/i.exec(readFileSync(dotGit, 'utf8').trim());
    if (!pointer) return null;
    const gitdir = pointer[1].trim();
    try {
      // worktree 的 commondir 相对指向主仓库 gitdir，分支列表在主仓库
      const common = readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
      return path.resolve(gitdir, common);
    } catch {
      return gitdir;
    }
  } catch {
    return null;
  }
}

/** 列出本地分支：松散 refs/heads/** + packed-refs，只读文件系统不拉起 git 进程 */
function listLocalBranches(gitDir: string): string[] {
  const branches = new Set<string>();
  const walk = (dir: string, prefix: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (statSync(full).isDirectory()) walk(full, prefix ? `${prefix}/${name}` : name);
        else branches.add(prefix ? `${prefix}/${name}` : name);
      } catch {
        // 不可读条目跳过
      }
    }
  };
  walk(path.join(gitDir, 'refs', 'heads'), '');
  try {
    for (const line of readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n')) {
      const m = /^[0-9a-f]{40} refs\/heads\/(.+)$/.exec(line.trim());
      if (m) branches.add(m[1]);
    }
  } catch {
    // 无 packed-refs 属正常
  }
  return [...branches];
}

/**
 * 检测默认基线分支：优先 main、其次 master，无提交仓库使用当前分支，其余返回 'main'。
 * 已有分支时不取当前检出分支（可能是 feature 分支）；返回值由 board_create 校验。
 */
function detectBaseBranch(repoPath: string): string {
  const gitDir = resolveGitDir(repoPath);
  if (!gitDir) return 'main';
  const branches = listLocalBranches(gitDir);
  if (branches.includes('main')) return 'main';
  if (branches.includes('master')) return 'master';
  if (branches.length === 0) {
    try {
      // symbolic-ref 只读查询，并验证真实 Git 仓库，避免将伪造的 .git/HEAD 当成未提交分支。
      const branch = execFileSync('git', ['-C', repoPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
        // 分支检测只认当前目录，避免宿主继承的 Git 上下文把查询路由到其他仓库。
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      }).trim();
      if (branch) return branch;
    } catch {
      // Git 不可用、仓库无效或 HEAD 已分离时保留默认值，由注册入口返回具体错误。
    }
  }
  return 'main';
}

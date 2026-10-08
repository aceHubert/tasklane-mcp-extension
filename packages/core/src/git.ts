import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Board, ChangeSummary, FileChange, WorkItem } from './work-item.js';
import { BoardError } from './errors.js';

const exec = promisify(execFile);

/**
 * 会覆盖目录发现/对象库选择的继承环境变量。宿主进程（bridge、终端）若带着
 * GIT_DIR / GIT_WORK_TREE 等变量启动，git 子进程会忽略 cwd 解析到完全错误
 * 的仓库（例如 registerBoard({repo: B}) 实际登记 A）。仓库路由只认 cwd，
 * 这些变量必须在子进程环境中剔除。
 */
const GIT_ROUTING_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_SUPER_PREFIX',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  // git 在子进程/hook 间传递 -c 配置的机制，与 GIT_CONFIG_COUNT/KEY_n 等价，
  // 宿主从 git hook 环境继承启动时同样存活，可注入 core.worktree 改写路由
  'GIT_CONFIG_PARAMETERS',
];

function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_ROUTING_ENV_KEYS) delete env[key];
  // GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> 成对等价于 -c 参数，同样可改写路由
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return env;
}

/** 解析符号链接后的真实绝对路径（路径不存在时退回 resolve，用于错误信息比较） */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** 未跟踪文件逐个统计行数的上限，防止超大未跟踪目录拖垮摘要 */
const MAX_UNTRACKED_FILES = 50;

/** 注册看板前的仓库校验结果 */
export interface RepoValidation {
  /** 主仓库根目录绝对路径（从 worktree/子目录注册时也指向主仓库） */
  root: string;
  /** 仓库身份键：git common dir 绝对路径，同仓库的 worktree/子目录/符号链接共享 */
  repoKey: string;
}

/** Task ↔ Git Worktree 绑定（M4 范围，v1 只做 branch/worktree 创建与 diff 摘要） */
export class GitService {
  constructor(readonly enabled = true) {}

  private async git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, env: sanitizedGitEnv() });
    return stdout.trim();
  }

  /** diff 类命令发现差异时 exit 1 属正常结果，返回 stdout 而非抛错 */
  private async gitDiff(args: string[], cwd?: string): Promise<string> {
    try {
      return await this.git(args, cwd);
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string };
      if (e.code === 1 && typeof e.stdout === 'string') return e.stdout.trim();
      throw err;
    }
  }

  async resolveRepo(repoHint?: string | null): Promise<string | null> {
    if (!this.enabled || !repoHint) return null;
    try {
      return await this.git(['rev-parse', '--show-toplevel'], repoHint);
    } catch {
      return null;
    }
  }

  private async branchExists(repo: string, branch: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo);
      return true;
    } catch {
      return false;
    }
  }

  private async hasHeadCommit(repo: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], repo);
      return true;
    } catch {
      return false;
    }
  }

  private async validBranchName(repo: string, branch: string): Promise<boolean> {
    try {
      return await this.git(['check-ref-format', '--branch', branch], repo) === branch;
    } catch {
      return false;
    }
  }

  private async commonDir(cwd: string): Promise<string> {
    return this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  }

  /**
   * 仓库身份识别：路径存在、是 Git 工作区、非裸仓库（不含提交或基线分支校验）。
   * 项目模式（open_tasklane）先据此匹配已登记看板：匹配成功即返回，
   * 不因后续传入的 baseBranch 无效而拒绝已登记仓库。
   * 与 validateRepoForBoard 一样不依赖 this.enabled（执行计划 §4.1）。
   */
  async identifyRepo(repoInput: string): Promise<RepoValidation> {
    if (!path.isAbsolute(repoInput)) {
      throw new BoardError('VALIDATION', `repo 必须是绝对路径: ${repoInput}`);
    }
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(repoInput);
    } catch {
      throw new BoardError('VALIDATION', `路径不存在: ${repoInput}`);
    }
    if (!st.isDirectory()) {
      throw new BoardError('VALIDATION', `路径不是目录: ${repoInput}`);
    }

    let toplevel: string;
    try {
      toplevel = await this.git(['rev-parse', '--show-toplevel'], repoInput);
    } catch {
      throw new BoardError('VALIDATION', `不是 Git 仓库（或 Git 不可用）: ${repoInput}`);
    }

    let commonDir: string;
    try {
      commonDir = await this.commonDir(toplevel);
    } catch {
      throw new BoardError('VALIDATION', `无法识别仓库身份: ${repoInput}`);
    }
    // common dir 位于 "<主仓库根>/.git"：worktree/子目录注册统一归位到主仓库
    const root = path.dirname(commonDir);
    if (path.basename(commonDir) !== '.git' || !existsSync(path.join(root, '.git'))) {
      throw new BoardError('VALIDATION', `无法定位主仓库根目录（非标准 Git 布局）: ${repoInput}`);
    }

    const bare = await this.git(['rev-parse', '--is-bare-repository'], root).catch(() => 'true');
    if (bare === 'true') {
      throw new BoardError('VALIDATION', `裸仓库不能注册为看板: ${root}`);
    }
    return { root, repoKey: commonDir };
  }

  /**
   * 仓库身份探测：明确不是 Git 仓库时返回 null（非 Git 项目注册/能力刷新用），
   * 其他失败（路径不存在、Git 不可用、损坏配置、裸仓库、非标准布局）按原语义抛错——
   * 不能把权限问题或损坏仓库静默降级为"普通非 Git 目录"。
   * 与 identifyRepo 一样不依赖 this.enabled（注册与刷新始终可用 Git 探测）。
   */
  async probeRepo(dirInput: string): Promise<RepoValidation | null> {
    if (!path.isAbsolute(dirInput)) {
      throw new BoardError('VALIDATION', `repo 必须是绝对路径: ${dirInput}`);
    }
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dirInput);
    } catch {
      throw new BoardError('VALIDATION', `路径不存在: ${dirInput}`);
    }
    if (!st.isDirectory()) {
      throw new BoardError('VALIDATION', `路径不是目录: ${dirInput}`);
    }
    try {
      // stderr 分类依赖英文 "not a git repository"：强制 C locale，避免继承
      // 用户环境的本地化 git 消息（中文输出会让非 Git 目录误判为需报告的错误）。
      await exec('git', ['rev-parse', '--show-toplevel'], {
        cwd: dirInput, maxBuffer: 16 * 1024 * 1024,
        env: { ...sanitizedGitEnv(), LC_ALL: 'C', LANG: 'C' },
      });
    } catch (err) {
      const e = err as { code?: number | string; stderr?: string; message?: string };
      // exit 128 + "not a git repository" 是明确的非 Git 目录；
      // 其他 128（裸仓库 "must be run in a work tree" 等）交给 identifyRepo
      // 按注册校验原语义分类；ENOENT（git 缺失）、损坏配置等是需报告的真实错误
      const stderr = typeof e.stderr === 'string' ? e.stderr : '';
      if (e.code === 128 && /not a git repository/i.test(stderr)) return null;
      if (e.code === 128) return this.identifyRepo(dirInput);
      throw new BoardError(
        'GIT_ERROR',
        `无法识别 Git 状态: ${dirInput}: ${stderr.trim() || e.message || String(err)}`,
      );
    }
    return this.identifyRepo(dirInput);
  }

  /**
   * 注册看板前的仓库校验：identifyRepo + 基线分支存在；首次提交前允许当前未诞生分支。
   * 从 worktree / 子目录注册时识别主仓库根目录。
   * 注意：注册校验不依赖 this.enabled（执行计划 §4.1 —— 即使任务 Git 功能
   * 关闭，注册仍需可用 Git），因此这里直接调底层 git 而不走 resolveRepo。
   */
  async validateRepoForBoard(repoInput: string, baseBranch: string): Promise<RepoValidation> {
    const validation = await this.identifyRepo(repoInput);
    if (!(await this.validBranchName(validation.root, baseBranch))) {
      throw new BoardError('VALIDATION', `基线分支名称无效: ${baseBranch}`);
    }
    if (!(await this.hasHeadCommit(validation.root))) {
      // 空仓库尚未创建分支引用，只接受 HEAD 指向的当前分支，不能登记任意名称。
      const current = await this.git(['symbolic-ref', '--quiet', 'HEAD'], validation.root).catch(() => '');
      if (current === `refs/heads/${baseBranch}`) return validation;
      throw new BoardError('VALIDATION', `首次提交前基线分支必须是当前分支: ${baseBranch}（当前 ${current || '未知'}）`);
    }
    if (!(await this.branchExists(validation.root, baseBranch))) {
      throw new BoardError(
        'VALIDATION',
        `基线分支不存在: ${baseBranch}（仓库 ${validation.root} 的本地分支中没有该分支）`,
      );
    }
    return validation;
  }

  /**
   * 为任务建立 task branch + 独立 worktree（已存在则复用）。
   * 关键约束：分支已存在时直接检出复用，绝不用 `worktree add -B` 把分支
   * 强制重置回基线 —— 那会静默丢弃 agent 已有提交。
   * 复用已有工作区前核验仓库身份与分支，不能把"目录存在"当成绑定正确。
   * 返回需要合并进 WorkItem 的 git 上下文字段；仓库不可用时返回 null（能力降级，不阻断流程）。
   */
  async ensureTaskContext(
    task: WorkItem,
    board: Board,
  ): Promise<Pick<WorkItem, 'repo' | 'baseBranch' | 'branch' | 'worktreePath'> | null> {
    const repo = await this.resolveRepo(board.repo);
    if (!repo) {
      if (this.enabled && board.repo) {
        throw new BoardError('GIT_ERROR', `仓库不可用，无法创建或复用任务工作区，请检查路径和 Git 环境: ${board.repo}`);
      }
      return null;
    }
    const baseBranch = board.baseBranch || 'main';
    // 看板可在首次提交前使用，worktree 则必须有提交及有效基线；校验先于任何创建或复用。
    if (!(await this.hasHeadCommit(repo))) {
      throw new BoardError('GIT_ERROR', `仓库尚无 HEAD 提交，请先由用户完成首次提交，再创建或复用任务工作区: ${repo}`);
    }
    if (!(await this.validBranchName(repo, baseBranch)) || !(await this.branchExists(repo, baseBranch))) {
      throw new BoardError('GIT_ERROR', `基线分支不存在或无效: ${baseBranch}（仓库 ${repo}）`);
    }
    // 标题清洗后为空（纯中文/纯符号）时分支名只保留任务 ID，
    // 不再拼接兜底后缀，避免 tasklane/TASK-1-task 这类与前缀重复的命名
    const titleSlug = slug(task.title);
    const branch = task.branch || `tasklane/${titleSlug ? `${task.id}-${titleSlug}` : task.id}`;
    const worktreePath = task.worktreePath || path.join(repo, '.worktrees', task.id);

    if (existsSync(worktreePath)) {
      await this.assertWorktreeMatches(worktreePath, repo, branch);
      return { repo, baseBranch, branch, worktreePath };
    }

    if (await this.branchExists(repo, branch)) {
      await this.git(['worktree', 'add', worktreePath, branch], repo);
    } else {
      await this.git(['worktree', 'add', '-b', branch, worktreePath, baseBranch], repo);
    }
    return { repo, baseBranch, branch, worktreePath };
  }

  /**
   * 复用前核验已有工作区（ensureTaskContext 与 diff 前的 refreshChanges 共用）：
   * 必须是有效 Git 工作区、自身就是工作区根目录（普通子目录不算）、与任务看板
   * 同仓库（common dir 一致）、检出分支与任务分支一致；不满足时明确报错，
   * 不能把陈旧目录当成正确绑定。
   */
  async assertWorktreeMatches(worktreePath: string, repo: string, branch: string): Promise<void> {
    let wtTop: string;
    try {
      wtTop = await this.git(['rev-parse', '--show-toplevel'], worktreePath);
    } catch {
      throw new BoardError('GIT_ERROR', `已有工作区不是有效 Git 仓库: ${worktreePath}`);
    }
    // worktreePath 必须自身就是工作区根：普通子目录的 --show-toplevel 会解析到
    // 所属主仓库（或父级 worktree）的根。不比对时，worktree 移除后在原路径重建的
    // 普通目录会被误认成独立 worktree，实际与主仓库共享索引
    if (realPath(wtTop) !== realPath(worktreePath)) {
      throw new BoardError(
        'GIT_ERROR',
        `已有目录不是独立 worktree 根（解析到 ${wtTop}）: ${worktreePath}`,
      );
    }
    const [wtCommon, repoCommon] = await Promise.all([this.commonDir(wtTop), this.commonDir(repo)]);
    if (wtCommon !== repoCommon) {
      throw new BoardError(
        'GIT_ERROR',
        `已有工作区属于其他仓库（${wtCommon} ≠ ${repoCommon}）: ${worktreePath}`,
      );
    }
    const current = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    if (current !== branch) {
      throw new BoardError(
        'GIT_ERROR',
        `已有工作区检出的是 ${current}，与任务分支 ${branch} 不匹配: ${worktreePath}`,
      );
    }
  }

  /**
   * 相对基线的最终变更摘要。
   * 锚点用 merge-base(base, HEAD)，diff 范围是「基线锚点 → 当前工作区」单次比较：
   * 已提交 + 暂存 + 未暂存一并覆盖，且"提交后又在工作区撤销"的改动不会重复累计。
   * 未跟踪文件不进 diff，单独按文件统计行数后合并。
   */
  async diffSummary(worktreePath: string, baseBranch: string): Promise<ChangeSummary> {
    const base = (await this.git(['merge-base', baseBranch, 'HEAD'], worktreePath)).trim();
    const [tracked, untracked] = await Promise.all([
      // core.quotePath=false：非 ASCII 文件名原样输出。默认的 C 风格转义
      // （"docs/\346\226\207.md"）会被当成字面路径参与统计，中文文件被静默漏掉
      this.gitDiff(['-c', 'core.quotePath=false', 'diff', '--numstat', base], worktreePath),
      // -z：NUL 分隔的原始路径，不做任何引用转义
      this.git(['ls-files', '--others', '--exclude-standard', '-z'], worktreePath).catch(() => ''),
    ]);

    const files = new Map<string, FileChange>();
    const accumulate = (out: string) => {
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const [added, removed, ...rest] = line.split('\t');
        const name = normalizeDiffPath(rest.join('\t'));
        if (!name) continue;
        const f = files.get(name) ?? { name, added: 0, removed: 0 };
        f.added += Number(added) || 0;
        f.removed += Number(removed) || 0;
        files.set(name, f);
      }
    };
    accumulate(tracked);

    for (const name of untracked.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED_FILES)) {
      accumulate(
        await this.gitDiff(
          ['-c', 'core.quotePath=false', 'diff', '--numstat', '--no-index', '--', '/dev/null', name],
          worktreePath,
        ).catch(() => ''),
      );
    }

    const list = [...files.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed));
    return {
      filesChanged: list.length,
      additions: list.reduce((sum, f) => sum + f.added, 0),
      deletions: list.reduce((sum, f) => sum + f.removed, 0),
      testStatus: 'unknown',
      files: list.slice(0, 5),
    };
  }
}

/**
 * numstat 的路径列可能是重命名格式："old => new"（含 --no-index /dev/null 的
 * "/dev/null => new"）或带公共前后缀的 "dir/{old => new}.ts"，统一归一为最终路径。
 */
function normalizeDiffPath(raw: string): string {
  const brace = raw.match(/^(.*?)\{[^{}]* => ([^{}]*)\}(.*)$/);
  if (brace) return `${brace[1]}${brace[2]}${brace[3]}`;
  const idx = raw.lastIndexOf(' => ');
  if (idx >= 0) return raw.slice(idx + 4);
  return raw;
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

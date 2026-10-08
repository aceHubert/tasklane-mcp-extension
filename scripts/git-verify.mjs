#!/usr/bin/env node
/**
 * 真实 git 集成验证：
 * S1 assign 不创建执行上下文；测试 fixture 显式建旧 worktree → 提交 → review 摘要
 * S2 暂存/工作区/未跟踪改动也能出现在 review 摘要
 * S3 分支已存在而 worktree 被移除时，fixture 复用分支、不重置到基线
 * S4 提交后又在工作区撤销 → 净零差异不计入
 * S5 多仓库隔离：A/B 各自分支/worktree，A 的 review 摘要不读 B
 * S6 注册去重：子目录/符号链接/worktree 视角注册同一仓库幂等；非法输入明确报错
 * S7 双引擎并发指派同一任务：只更新负责人，不创建 worktree/session
 * S8 旧 fixture 与原生绑定只读核验：错仓库/目录/分支/模式均拒绝
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BoardEngine, GitService, JsonFileBoardStore, BoardError } from '@tasklane/core';

const hardTimeout = setTimeout(() => {
  console.error('GIT VERIFY FAILED：超过 60 秒硬超时');
  process.exit(1);
}, 60000);

// 仅测试旧 Git 上下文及摘要；这不是产品执行入口，不代表原生 Agent 启动。
async function assignWithLegacyFixture(engine, store, gitService, id, boardId) {
  const assigned = await engine.assignTask(id, 'agent', boardId);
  const context = await gitService.ensureTaskContext(assigned, store.getBoard(assigned.boardId));
  if (!context) throw new Error('临时 Git fixture 未创建上下文');
  return store.mutateTask(id, (current) => ({ ...current, ...context }));
}

const results = [];
function check(label, cond) {
  results.push([label, cond]);
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`);
}

function makeRepo(prefix, baseBranch = 'main') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const g = (args, cwd = dir) => execFileSync('git', args, { cwd, timeout: 5000 }).toString().trim();
  g(['init', '-q', '-b', baseBranch]);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(path.join(dir, 'base.txt'), 'hello\n');
  g(['add', '.']);
  g(['commit', '-qm', 'init']);
  return { dir, g };
}

const repo = mkdtempSync(path.join(tmpdir(), 'ck-repo-'));
const home = mkdtempSync(path.join(tmpdir(), 'ck-home-'));
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, timeout: 5000 }).toString().trim();

git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 't@t']);
git(['config', 'user.name', 't']);
writeFileSync(path.join(repo, 'base.txt'), 'hello\n');
git(['add', '.']);
git(['commit', '-qm', 'init']);

process.env.TASKLANE_REPO = repo;
process.env.TASKLANE_HOME = home;
process.env.TASKLANE_BASE_BRANCH = 'main';
const store = new JsonFileBoardStore(path.join(home, 'board.json'));
const gitService = new GitService(true);
const engine = new BoardEngine(store, gitService);

/* ---------- S1：assign 无创建副作用；旧 worktree fixture → review 摘要 ---------- */
const t = await engine.createTask({ title: 'Implement OAuth callback handler' });
const refsBeforeAssign = git(['for-each-ref', '--format=%(refname)']);
const worktreesBeforeAssign = git(['worktree', 'list', '--porcelain']);
const onlyAssigned = await engine.assignTask(t.id, 'agent');
check(
  'S1 assign 不创建 branch/worktree/session/runId/绑定',
  onlyAssigned.assignee === 'agent' && onlyAssigned.execution.state === 'assigned' &&
    !onlyAssigned.branch && !onlyAssigned.worktreePath && !onlyAssigned.execution.sessionId &&
    !onlyAssigned.execution.runId && !onlyAssigned.executionBinding &&
    git(['for-each-ref', '--format=%(refname)']) === refsBeforeAssign &&
    git(['worktree', 'list', '--porcelain']) === worktreesBeforeAssign,
);
const assigned = await assignWithLegacyFixture(engine, store, gitService, t.id);
console.log('branch:', assigned.branch);
console.log('worktree:', assigned.worktreePath);

// 模拟 agent 在 worktree 里改动文件并提交
writeFileSync(path.join(assigned.worktreePath, 'auth.ts'), 'export {};\n'.repeat(10));
mkdirSync(path.join(assigned.worktreePath, 'tests'), { recursive: true });
writeFileSync(path.join(assigned.worktreePath, 'tests', 'auth.test.ts'), 'test();\n'.repeat(5));
git(['add', '.'], assigned.worktreePath);
git(['commit', '-qm', 'wip auth'], assigned.worktreePath);

await engine.moveTask(t.id, 'doing');
const review = await engine.moveTask(t.id, 'review');
console.log('S1 filesChanged:', review.changes?.filesChanged, '| additions:', review.changes?.additions);
console.log('S1 top files:', review.changes?.files.map((f) => f.name).join(', '));

check('S1 显式 fixture 创建旧 branch/worktree，业务流转不写 running', Boolean(review.branch && review.worktreePath) && review.execution.state === 'assigned' && !review.execution.sessionId);
check('S1 review 摘要含 2 个提交文件', review.changes?.filesChanged === 2 && (review.changes?.additions ?? 0) > 0);

/* ---------- S2：未提交改动也要进摘要 ---------- */
const t2 = await engine.createTask({ title: 'Uncommitted changes visibility' });
const a2 = await assignWithLegacyFixture(engine, store, gitService, t2.id);
writeFileSync(path.join(a2.worktreePath, 'staged.ts'), 'a;\n'.repeat(3));
git(['add', 'staged.ts'], a2.worktreePath); // 新文件：暂存未提交
writeFileSync(path.join(a2.worktreePath, 'base.txt'), 'hello\nworld\n'); // 已跟踪文件：工作区修改未暂存
writeFileSync(path.join(a2.worktreePath, 'untracked.ts'), 'c;\n'.repeat(4)); // 未跟踪
await engine.moveTask(t2.id, 'doing');
const r2 = await engine.moveTask(t2.id, 'review');
const names = r2.changes?.files.map((f) => f.name) ?? [];
console.log('S2 files:', names.join(', '), '| additions:', r2.changes?.additions);
check(
  'S2 暂存/工作区/未跟踪文件都进入摘要',
  names.includes('staged.ts') && names.includes('base.txt') && names.includes('untracked.ts'),
);

/* ---------- S3：分支已存在 + worktree 被移除 → 不重置分支 ---------- */
const headBefore = git(['rev-parse', 'HEAD'], assigned.worktreePath);
git(['worktree', 'remove', '--force', assigned.worktreePath]);

// 新 store（同 repo）：任务无 git 字段但同名分支已存在
const home2 = mkdtempSync(path.join(tmpdir(), 'ck-home2-'));
const store2 = new JsonFileBoardStore(path.join(home2, 'board.json'));
const gitService2 = new GitService(true);
const engine2 = new BoardEngine(store2, gitService2);
const t3 = await engine2.createTask({ title: 'Implement OAuth callback handler' }); // 同标题 → 同分支名
const a3 = await assignWithLegacyFixture(engine2, store2, gitService2, t3.id);
const headAfter = git(['rev-parse', 'HEAD'], a3.worktreePath);
const baseHead = git(['rev-parse', 'main']);
console.log('S3 branch:', a3.branch, '| reuse:', a3.branch === assigned.branch);

check('S3 worktree 重建且复用既有分支', a3.branch === assigned.branch && a3.worktreePath === assigned.worktreePath);
check('S3 分支未被重置到基线（保留 agent 提交）', headAfter === headBefore && headAfter !== baseHead);

// 仅 fixture 预置历史内部标识；普通指派/业务流转不能把它升级成原生执行。
const legacy = store2.mutateTask(t3.id, (current) => ({
  ...current,
  execution: { ...current.execution, state: 'waiting', sessionId: 'sess-legacy-fixture', activity: '历史未核实状态' },
}));
await engine2.assignTask(t3.id, 'human');
await engine2.assignTask(t3.id, 'agent');
for (const status of ['doing', 'review', 'done']) await engine2.moveTask(t3.id, status);
const legacyAfter = store2.getTask(t3.id);
check('S3 改派及业务完成保留 legacy 字段，不伪写执行完成',
  ['repo', 'baseBranch', 'branch', 'worktreePath'].every((field) => legacyAfter[field] === legacy[field]) &&
  JSON.stringify(legacyAfter.execution) === JSON.stringify(legacy.execution) && !legacyAfter.executionBinding &&
  git(['rev-parse', 'HEAD'], legacyAfter.worktreePath) === headBefore);

/* ---------- S4：提交后又在工作区撤销 → 净零差异不计入 ---------- */
const t4 = await engine.createTask({ title: 'Net zero changes' });
const a4 = await assignWithLegacyFixture(engine, store, gitService, t4.id);
writeFileSync(path.join(a4.worktreePath, 'transient.ts'), 'x;\n'.repeat(5));
git(['add', 'transient.ts'], a4.worktreePath);
git(['commit', '-qm', 'add transient'], a4.worktreePath);
rmSync(path.join(a4.worktreePath, 'transient.ts')); // 工作区删除 → 相对基线净零
await engine.moveTask(t4.id, 'doing');
const r4 = await engine.moveTask(t4.id, 'review');
console.log('S4 filesChanged:', r4.changes?.filesChanged);
check('S4 提交后又撤销的文件不重复累计（净零）', r4.changes?.filesChanged === 0);

/* ---------- S5：多仓库隔离（A/B 各自 Git 路由与摘要） ---------- */
delete process.env.TASKLANE_REPO; // 后续看板全部走显式注册
const homeMulti = mkdtempSync(path.join(tmpdir(), 'ck-multi-'));
const multiStore = new JsonFileBoardStore(path.join(homeMulti, 'board.json'));
// 第一个看板是未绑定仓库的 default；注册 A/B 形成三看板
const gitMulti = new GitService(true);
const engineMulti = new BoardEngine(multiStore, gitMulti);

const repoA = makeRepo('ck-repoA-');
const repoB = makeRepo('ck-repoB-', 'develop'); // B 使用不同基线分支
const boardA = await engineMulti.registerBoard({ repo: repoA.dir, name: '项目 A', baseBranch: 'main' });
const boardB = await engineMulti.registerBoard({ repo: repoB.dir, name: '项目 B', baseBranch: 'develop' });
console.log('S5 boards:', boardA.id, boardB.id);

const ta = await engineMulti.createTask({ title: 'Feature in repo A', boardId: boardA.id });
const tb = await engineMulti.createTask({ title: 'Feature in repo B', boardId: boardB.id });
const aa = await assignWithLegacyFixture(engineMulti, multiStore, gitMulti, ta.id, boardA.id);
const ab = await assignWithLegacyFixture(engineMulti, multiStore, gitMulti, tb.id, boardB.id);

check(
  'S5 A/B worktree 分别落在各自仓库',
  aa.worktreePath?.startsWith(realpathSync(repoA.dir)) && ab.worktreePath?.startsWith(realpathSync(repoB.dir)),
);
check(
  'S5 A/B 基线分支各自生效',
  aa.baseBranch === 'main' && ab.baseBranch === 'develop',
);

// A 提交改动；B 也提交改动。A 进 review 的摘要只应包含 A 的文件
writeFileSync(path.join(aa.worktreePath, 'a-only.ts'), 'a;\n'.repeat(4));
repoA.g(['add', '.'], aa.worktreePath);
repoA.g(['commit', '-qm', 'a work'], aa.worktreePath);
writeFileSync(path.join(ab.worktreePath, 'b-only.ts'), 'b;\n'.repeat(4));
repoB.g(['add', '.'], ab.worktreePath);
repoB.g(['commit', '-qm', 'b work'], ab.worktreePath);

await engineMulti.moveTask(ta.id, 'doing', boardA.id);
const reviewA = await engineMulti.moveTask(ta.id, 'review', boardA.id);
const filesA = reviewA.changes?.files.map((f) => f.name) ?? [];
console.log('S5 review(A) files:', filesA.join(', '));
check(
  'S5 A 的 review 摘要只含 A 的文件（不读 B）',
  filesA.includes('a-only.ts') && !filesA.includes('b-only.ts'),
);

const boardsMulti = engineMulti.boardList();
check(
  'S5 各看板独立计数',
  boardsMulti.find((b) => b.id === boardA.id)?.counts.review === 1 &&
    boardsMulti.find((b) => b.id === boardB.id)?.counts.backlog === 1,
);

/* ---------- S6：注册去重与非法输入 ---------- */
// 子目录视角：先建一个子目录再从它注册
mkdirSync(path.join(repoA.dir, 'sub'), { recursive: true });
writeFileSync(path.join(repoA.dir, 'sub', 'x.txt'), 'x\n');
const regSub = await engineMulti.registerBoard({ repo: path.join(repoA.dir, 'sub') });
check('S6 从子目录注册归位主仓库并幂等', regSub.id === boardA.id && regSub.repo === realpathSync(repoA.dir));

// 符号链接视角
const linkDir = mkdtempSync(path.join(tmpdir(), 'ck-link-'));
const link = path.join(linkDir, 'repo-link');
symlinkSync(realpathSync(repoA.dir), link);
const regLink = await engineMulti.registerBoard({ repo: link });
check('S6 从符号链接注册归位主仓库并幂等', regLink.id === boardA.id);

// worktree 视角：从 A 的任务 worktree 注册也不产生新看板
const regWt = await engineMulti.registerBoard({ repo: aa.worktreePath });
check('S6 从任务 worktree 注册识别主仓库并幂等', regWt.id === boardA.id);

check(
  'S6 重复注册未产生多余看板',
  engineMulti.boardList().filter((b) => b.repoKey === boardA.repoKey).length === 1,
);

// 非法输入：不存在的路径 / 文件路径 / 不存在的基线分支 / 裸仓库
// （非 Git 目录现在合法注册为项目看板：repoKey 为空、projectDir 记录真实路径）
const notRepo = realpathSync(mkdtempSync(path.join(tmpdir(), 'ck-notrepo-')));
const nonGitBoard = await engineMulti.registerBoard({ repo: notRepo, name: '非 Git 项目' });
check(
  'S6 非 Git 目录注册为项目看板（无仓库身份、目录幂等去重）',
  nonGitBoard.repoKey === null && nonGitBoard.repo === null && nonGitBoard.projectDir === notRepo &&
    (await engineMulti.registerBoard({ repo: notRepo })).id === nonGitBoard.id,
);
const plainFile = path.join(notRepo, 'plain-file.txt');
writeFileSync(plainFile, 'not a directory');
let errCount = 0;
for (const [label, input] of [
  ['不存在路径', { repo: '/nonexistent/path/xyz' }],
  ['文件路径', { repo: plainFile }],
  ['不存在分支', { repo: repoB.dir, baseBranch: 'no-such' }],
]) {
  try {
    await engineMulti.registerBoard(input);
    console.error(`  S6 非法输入未被拒绝: ${label}`);
  } catch (err) {
    if (err instanceof BoardError && err.code === 'VALIDATION') errCount += 1;
    else console.error(`  S6 ${label} 错误码异常:`, err?.code ?? err?.message);
  }
}
const bare = mkdtempSync(path.join(tmpdir(), 'ck-bare-'));
execFileSync('git', ['init', '-q', '--bare', bare], { timeout: 5000 });
try {
  await engineMulti.registerBoard({ repo: bare });
  console.error('  S6 裸仓库未被拒绝');
} catch (err) {
  if (err instanceof BoardError && err.code === 'VALIDATION') errCount += 1;
  else console.error(`  S6 裸仓库错误码异常:`, err?.code ?? err?.message);
}
check('S6 非法注册输入（路径/文件/分支/裸仓库）全部明确报错', errCount === 4);

/* ---------- S7：双引擎并发指派同一任务，无执行创建副作用 ---------- */
const homeConc = mkdtempSync(path.join(tmpdir(), 'ck-conc-'));
const repoC = makeRepo('ck-repoC-');
const storeCa = new JsonFileBoardStore(path.join(homeConc, 'board.json'));
const storeCb = new JsonFileBoardStore(path.join(homeConc, 'board.json'));
const engineCa = new BoardEngine(storeCa, new GitService(true));
const engineCb = new BoardEngine(storeCb, new GitService(true));
const boardC = await engineCa.registerBoard({ repo: repoC.dir, name: 'C', baseBranch: 'main' });
const tc = await engineCa.createTask({ title: 'Concurrent assign', boardId: boardC.id });

// 两个引擎实例（模拟两个 MCP 进程共用存储）同时指派同一任务
await Promise.all([
  engineCa.assignTask(tc.id, 'agent', boardC.id),
  engineCb.assignTask(tc.id, 'agent', boardC.id),
]);
const wtList = repoC.g(['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean);
const taskWorktrees = wtList.filter((w) => w.includes(tc.id));
console.log('S7 worktree entries for task:', taskWorktrees.length);
const concurrentAssigned = storeCa.getTask(tc.id);
check('S7 并发指派不生成任何任务工作区或 session', taskWorktrees.length === 0 && concurrentAssigned.assignee === 'agent' && !concurrentAssigned.worktreePath && !concurrentAssigned.branch && !concurrentAssigned.execution.sessionId && !concurrentAssigned.executionBinding);

/* ---------- S9：resolveProjectBoard（项目模式入口语义） ---------- */
const repoE = makeRepo('ck-repoE-');
const engineE = new BoardEngine(
  new JsonFileBoardStore(path.join(mkdtempSync(path.join(tmpdir(), 'ck-proj-')), 'board.json')),
  new GitService(true),
);
const boardE = await engineE.registerBoard({ repo: repoE.dir, name: '项目 E', baseBranch: 'main' });
// 已登记仓库：传入无效基线也直接复用既有看板（不覆盖名称/基线）
const resolved = await engineE.resolveProjectBoard({ repo: repoE.dir, baseBranch: 'no-such' });
check(
  'S9 已登记仓库按身份复用（忽略无效 baseBranch）',
  resolved.id === boardE.id && resolved.baseBranch === 'main' && resolved.name === '项目 E',
);
// 未登记仓库（trunk 基线）：默认 main 不存在 → 报错不创建错误绑定
const repoF = makeRepo('ck-repoF-', 'trunk');
let failedDefault = false;
try {
  await engineE.resolveProjectBoard({ repo: repoF.dir });
} catch (err) {
  failedDefault = err instanceof BoardError && err.code === 'VALIDATION' && /main/.test(err.message);
}
check(
  'S9 未登记 + 默认基线缺失 → 报错且不创建看板',
  failedDefault && !engineE.boardList().some((b) => b.repo === realpathSync(repoF.dir)),
);
// 未登记 + 显式 trunk 基线 → 注册成功；子目录视角复用同一看板
const resolvedF = await engineE.resolveProjectBoard({ repo: repoF.dir, baseBranch: 'trunk' });
mkdirSync(path.join(repoF.dir, 'pkg'), { recursive: true });
writeFileSync(path.join(repoF.dir, 'pkg', 'x.txt'), 'x\n');
const resolvedSub = await engineE.resolveProjectBoard({ repo: path.join(repoF.dir, 'pkg') });
check(
  'S9 未登记 + 显式基线注册；子目录视角复用',
  Boolean(resolvedF.id) && resolvedSub.id === resolvedF.id && resolvedF.baseBranch === 'trunk',
);

/* ---------- S8：复用核验（已有目录绑定错误仓库时明确报错） ---------- */
const repoD = makeRepo('ck-repoD-');
const boardD = await engineMulti.registerBoard({ repo: repoD.dir, name: 'D', baseBranch: 'main' });
// 预置一个指向"错误仓库"（repoB）的目录作为任务 worktree 路径
const wrongDir = path.join(repoD.dir, '.worktrees', 'TASK-WRONG');
repoB.g(['worktree', 'add', '-b', 'wrong-binding', wrongDir, 'develop']); // 属于 repoB 的 worktree，落在 repoD 的命名空间
const tWrong = await engineMulti.createTask({ title: 'Wrong binding', boardId: boardD.id });
const storeW = multiStore;
storeW.mutateTask(tWrong.id, (cur) => ({
  ...cur,
  assignee: 'human',
  worktreePath: wrongDir,
  branch: `tasklane/${tWrong.id}-wrong-binding`,
}));
const wrongBefore = storeW.getTask(tWrong.id);
const aWrong = await engineMulti.assignTask(tWrong.id, 'agent', boardD.id);
check('S8 assign 不核验/重绑旧目录，原 legacy 上下文保留',
  aWrong.assignee === 'agent' && ['repo', 'baseBranch', 'branch', 'worktreePath'].every((field) => aWrong[field] === wrongBefore[field]) && !aWrong.executionBinding);
let fixtureRejected = false;
try {
  await assignWithLegacyFixture(engineMulti, storeW, gitMulti, tWrong.id, boardD.id);
} catch (err) {
  fixtureRejected = err instanceof BoardError && err.code === 'GIT_ERROR' && /其他仓库/.test(err.message);
}
check('S8 显式旧 fixture 校验错误仓库并拒绝合并', fixtureRejected && storeW.getTask(tWrong.id).worktreePath === wrongDir);

// 原生绑定只读校验；测试线程标识只是协议 fixture，不是真实 Agent。
const makeBinding = async (task, workspaceMode, result) => {
  const { request } = await engineMulti.requestExecution({
    id: task.id, boardId: task.boardId, requestId: `git-${task.id}`, action: 'start', workspaceMode,
    hostId: 'git-verify-host', receiverThreadId: 'git-verify-receiver',
  });
  const claim = { id: task.id, boardId: task.boardId, requestId: request.requestId, runId: request.runId, claimId: `claim-${task.id}` };
  await engineMulti.claimExecution(claim);
  return { ...claim, phase: 'created', hostId: 'git-verify-host', threadId: `thread-${task.id}`, ...result };
};
const rejectBinding = async (label, input) => {
  // 每个拒绝场景使用独立请求；已记录的原生结果不可在同一请求中替换。
  const original = storeW.getTask(input.id);
  const task = await engineMulti.createTask({ title: label, boardId: input.boardId });
  storeW.mutateTask(task.id, (current) => ({ ...current,
    repo: original.repo, baseBranch: original.baseBranch,
    branch: original.branch, worktreePath: original.worktreePath,
  }));
  const mode = original.executionRequests.find((request) => request.runId === input.runId).workspaceMode;
  const pending = await makeBinding(storeW.getTask(task.id), mode, {
    workspacePath: input.workspacePath, workspaceOwner: input.workspaceOwner, branch: input.branch,
  });
  await engineMulti.bindExecution(pending);
  const before = JSON.stringify(storeW.getTask(task.id));
  let rejected = false;
  try { await engineMulti.bindExecution({ ...pending, phase: 'bound' }); } catch (err) { rejected = err instanceof BoardError && err.code === 'GIT_ERROR'; }
  const unchanged = storeW.getTask(task.id);
  check(label, rejected && !unchanged.executionBinding && unchanged.executionRequests[0].result.threadId === pending.threadId &&
    unchanged.execution.state === 'starting' && JSON.stringify(unchanged) === before);
};
const refsBeforeBind = repoD.g(['for-each-ref', '--format=%(refname)']);
const worktreesBeforeBind = repoD.g(['worktree', 'list', '--porcelain']);
const foreign = await makeBinding(aWrong, 'existing', { workspacePath: wrongDir, workspaceOwner: 'tasklane', branch: aWrong.branch });
await rejectBinding('S8 原生绑定拒绝属于其他仓库的工作区', foreign);

const taskProject = await engineMulti.createTask({ title: 'Project binding', boardId: boardD.id });
const projectBinding = await makeBinding(taskProject, 'project', { workspacePath: boardD.repo, workspaceOwner: 'user', branch: 'main' });
mkdirSync(path.join(repoD.dir, 'nested'), { recursive: true });
await rejectBinding('S8 主仓库模式拒绝普通子目录', { ...projectBinding, workspacePath: path.join(repoD.dir, 'nested') });
await rejectBinding('S8 主仓库模式拒绝其他仓库根', { ...projectBinding, workspacePath: repoA.dir });
const createdProject = await engineMulti.bindExecution(projectBinding);
const boundProject = await engineMulti.bindExecution({ ...projectBinding, phase: 'bound' });
check('S8 主仓库 created → bound 成功且仅 starting', createdProject.request.status === 'created' && boundProject.request.status === 'bound' && boundProject.task.execution.state === 'starting' && !boundProject.task.worktreePath);

const taskWorktree = await engineMulti.createTask({ title: 'Independent binding', boardId: boardD.id });
const independent = await makeBinding(taskWorktree, 'worktree', { workspacePath: boardD.repo, workspaceOwner: 'codex', branch: 'main' });
await rejectBinding('S8 独立工作区模式拒绝主仓库', independent);
check('S8 请求/认领/绑定不创建分支或 worktree', repoD.g(['for-each-ref', '--format=%(refname)']) === refsBeforeBind && repoD.g(['worktree', 'list', '--porcelain']) === worktreesBeforeBind);

const existingBinding = await makeBinding(aa, 'existing', { workspacePath: aa.worktreePath, workspaceOwner: 'tasklane', branch: aa.branch });
await rejectBinding('S8 旧 worktree 不允许换目录', { ...existingBinding, workspacePath: boardA.repo });
mkdirSync(path.join(aa.worktreePath, 'nested'), { recursive: true });
await rejectBinding('S8 旧 worktree 不允许绑定子目录', { ...existingBinding, workspacePath: path.join(aa.worktreePath, 'nested') });
await rejectBinding('S8 旧 worktree 不允许换分支', { ...existingBinding, branch: 'main' });
await engineMulti.bindExecution(existingBinding);
const boundExisting = await engineMulti.bindExecution({ ...existingBinding, phase: 'bound' });
check('S8 正确旧 worktree 原样复用并保留 legacy Git 字段', boundExisting.request.status === 'bound' && ['repo', 'baseBranch', 'branch', 'worktreePath'].every((field) => boundExisting.task[field] === aa[field]));
repoB.g(['worktree', 'remove', '--force', wrongDir]);

clearTimeout(hardTimeout);
const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? '\nGIT VERIFY PASSED' : `\nGIT VERIFY FAILED (${failed.length})`);
process.exit(failed.length === 0 ? 0 : 1);

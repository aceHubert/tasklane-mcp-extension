#!/usr/bin/env node
/**
 * 插件 bundle 冒烟：驱动 plugins/tasklane/server.mjs（自包含产物，脱离仓库 node_modules 运行），
 * 验证 Codex 应用面板契约（插件名 TaskLane）：initialize（serverInfo.icons）→ 10 tools
 * （9 板面 + open_tasklane）→ widget resource（MIME + 注入的 MCP Apps 桥）
 * → open_tasklane 全局/项目双模式（自动注册、幂等、子目录归位、无效路径拒绝）
 * → 板面 tool 与 widget 共用同一 server。
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(path.join(tmpdir(), 'ck-plugin-'));
const serverPath = path.join(ROOT, 'plugins', 'tasklane', 'server.mjs');
const emptyRepo = mkdtempSync(path.join(tmpdir(), 'ck-plugin-empty-repo-'));
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: emptyRepo });

/* 临时 Git 仓库：open_tasklane 项目模式的自动注册目标（注册校验不受 TASKLANE_GIT=off 影响） */
const repoP = mkdtempSync(path.join(tmpdir(), 'ck-plugin-repo-'));
{
  const g = (args) => execFileSync('git', args, { cwd: repoP }).toString().trim();
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(path.join(repoP, 'base.txt'), 'hello\n');
  g(['add', '.']);
  g(['commit', '-qm', 'init']);
}
writeFileSync(path.join(repoP, 'nested.txt'), 'x\n');

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, TASKLANE_HOME: home, TASKLANE_GIT: 'off' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const pending = new Map();
let nextId = 0;
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  } catch {
    /* ignore noise */
  }
});

function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 10000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const call = (name, args = {}) => request('tools/call', { name, arguments: args });

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'verify-plugin', version: '0.0.0' },
  });
  check('initialize ok', !init.error, init.error?.message);
  const serverInfo = init.result?.serverInfo ?? {};
  check('serverInfo.name = tasklane', serverInfo.name === 'tasklane', JSON.stringify(serverInfo));
  check('serverInfo.icons present (sidebar fallback)', Array.isArray(serverInfo.icons) && serverInfo.icons.length > 0);
  check('instructions present', typeof init.result?.instructions === 'string' && init.result.instructions.length > 0);
  notify('notifications/initialized');

  const tools = await request('tools/list', {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  const expected = [
    'task_export',
    'board_list', 'board_create', 'dir_list', 'model_list', 'task_list', 'task_get',
    'task_create', 'task_update', 'task_delete', 'task_move',
    'task_archive', 'task_restore', 'task_archive_done',
    'task_execution', 'task_execution_recover', 'open_tasklane', 'tasklane_host_info',
  ];
  const visibility = (name) => {
    const tool = (tools.result?.tools ?? []).find((t) => t.name === name);
    return Array.isArray(tool?._meta?.ui?.visibility) ? tool._meta.ui.visibility : undefined;
  };
  check(`tools/list 收敛为 ${expected.length} 个工具（11 模型可见 + 7 app-only）`,
    names.length === expected.length && expected.every((n) => names.includes(n)) &&
      ['task_export', 'dir_list', 'model_list', 'task_delete', 'task_archive_done', 'task_execution_recover', 'tasklane_host_info']
        .every((n) => visibility(n)?.includes('app') && !visibility(n)?.includes('model')) &&
      ['task_update', 'task_execution', 'task_list', 'task_archive'].every((n) => visibility(n) === undefined || visibility(n)?.includes('model')),
    `got: ${names.join(', ')}`);

  const openTool = (tools.result?.tools ?? []).find((t) => t.name === 'open_tasklane');
  const meta = openTool?._meta ?? {};
  check('open_tasklane exposes ui.resourceUri', meta.ui?.resourceUri === 'ui://widget/tasklane/board-panel-v0320.html', JSON.stringify(meta.ui));
  const entrypoints = meta['openai/ui']?.entrypoints ?? [];
  check('open_tasklane has global entrypoint', entrypoints.some((entry) => entry.type === 'global'));
  check('open_tasklane has thread entrypoint', entrypoints.some((entry) => entry.type === 'thread'));
  check('打开工具关联原生 UI 模板', meta['openai/outputTemplate'] === meta.ui?.resourceUri);
  check('open_tasklane widgetAccessible', meta['openai/widgetAccessible'] === true);
  check(
    'open_tasklane declares projectDir input',
    JSON.stringify(openTool?.inputSchema ?? {}).includes('projectDir'),
  );

  /* ---------- report 报告卡片绑定 ---------- */
  const reportTool = (tools.result?.tools ?? []).find((t) => t.name === 'task_execution');
  const reportMeta = reportTool?._meta ?? {};
  const reportUri = 'ui://widget/tasklane/report-card-v0320.html';
  check('task_execution（report 分支）绑定独立报告卡片，不复用默认打开的看板',
    reportMeta.ui?.resourceUri === reportUri && reportUri !== meta.ui?.resourceUri &&
    reportMeta['openai/outputTemplate'] === reportUri &&
    reportMeta['openai/widgetAccessible'] === true &&
    typeof reportMeta['openai/toolInvocation/invoking'] === 'string' &&
    typeof reportMeta['openai/toolInvocation/invoked'] === 'string',
    JSON.stringify(reportMeta));
  check('报告卡片工具不添加侧边栏入口', reportMeta['openai/ui'] === undefined, JSON.stringify(reportMeta['openai/ui']));

  /* ---------- 全局模式 ---------- */
  const open = await call('open_tasklane');
  const widgetData = open.result?._meta?.widgetData ?? open.result?.structuredContent;
  check('打开结果回传实际 MCP initialize 客户端而非猜测 UI 宿主',
    widgetData?.mcpClient?.name === 'verify-plugin' && widgetData?.mcpClient?.version === '0.0.0', JSON.stringify(widgetData?.mcpClient));
  const forgedClient = await call('open_tasklane', { mcpClient: { name: 'codex', version: 'forged' } });
  check('调用参数不能伪造 MCP 客户端身份', forgedClient.result?.structuredContent?.mcpClient?.name === 'verify-plugin');
  check('全局结果关联原生 UI 模板', open.result?._meta?.['openai/outputTemplate'] === meta.ui?.resourceUri);
  check(
    'open_tasklane 无参 → 全局模式',
    widgetData?.mode === 'global' && widgetData?.widget === 'tasklane-board' && widgetData?.boardHome === path.join(home, 'board.json'),
    JSON.stringify(widgetData),
  );

  /* ---------- 项目模式：自动注册 → 幂等 → 子目录归位 ---------- */
  // macOS 临时目录带符号链接（/var → /private/var）：Git 返回真实路径，断言用 realpath 归一
  const realRepoP = realpathSync(repoP);
  const openProject = await call('open_tasklane', { projectDir: repoP });
  const pd = openProject.result?._meta?.widgetData ?? openProject.result?.structuredContent;
  check('项目结果关联原生 UI 模板', openProject.result?._meta?.['openai/outputTemplate'] === meta.ui?.resourceUri);
  check(
    'open_tasklane 项目模式自动注册并锁定',
    pd?.mode === 'project' && Boolean(pd?.lockedBoardId) && pd?.repoRoot === realRepoP && pd?.projectDir === repoP,
    JSON.stringify(pd),
  );

  const again = await call('open_tasklane', { projectDir: repoP });
  const pd2 = again.result?._meta?.widgetData ?? again.result?.structuredContent;
  check('重复打开复用同一 lockedBoardId（幂等）', pd2?.lockedBoardId === pd?.lockedBoardId);

  // 从仓库内子目录打开：归位主仓库，projectDir 保留聊天目录，lockedBoardId 不变
  const subDir = path.join(repoP, 'pkg');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(path.join(subDir, 'x.txt'), 'x\n');
  const sub = await call('open_tasklane', { projectDir: subDir });
  const sd = sub.result?._meta?.widgetData ?? sub.result?.structuredContent;
  check(
    '子目录打开归位主仓库（同 lockedBoardId，projectDir 保留）',
    sd?.lockedBoardId === pd?.lockedBoardId && sd?.repoRoot === realRepoP && sd?.projectDir === subDir,
    JSON.stringify(sd),
  );

  // 错误结果必须携带 structuredContent（widget 标识 + 模式）：widget 端
  // parseWidgetContext 靠它识别来源并渲染 project-error 空态；缺失时错误
  // 上下文被丢弃，widget 会静默回退全局看板
  const missing = await call('open_tasklane', { projectDir: path.join(repoP, 'sub-dir-not-exist') });
  const md = missing.result?._meta?.widgetData ?? missing.result?.structuredContent;
  check(
    '不存在的项目路径明确报错（不回退全局）',
    missing.result?.isError === true && /VALIDATION/.test(missing.result?.content?.[0]?.text ?? ''),
  );
  check('错误结果带 widget 标识（widget 渲染 project-error）', md?.widget === 'tasklane-board' && md?.mode === 'project', JSON.stringify(md));
  check('错误结果仍关联原生 UI 模板', missing.result?._meta?.['openai/outputTemplate'] === meta.ui?.resourceUri);

  // 无提交仓库仍能打开锁定的项目看板；登记与任务管理不会偷偷创建 Git 提交。
  const beforeEmpty = await call('board_list');
  const empty = await call('open_tasklane', { projectDir: emptyRepo });
  const emptyData = empty.result?.structuredContent;
  check('无提交仓库打开原生项目看板',
    empty.result?.isError !== true && emptyData?.mode === 'project' && Boolean(emptyData?.lockedBoardId) &&
    emptyData?.repoRoot === realpathSync(emptyRepo) &&
    empty.result?._meta?.['openai/outputTemplate'] === meta.ui?.resourceUri);
  const afterEmpty = await call('board_list');
  const beforeBoards = JSON.parse(beforeEmpty.result?.content?.[0]?.text ?? '{}').boards ?? [];
  const afterBoards = JSON.parse(afterEmpty.result?.content?.[0]?.text ?? '{}').boards ?? [];
  check('只登记该空仓库，不修改其他看板',
    afterBoards.length === beforeBoards.length + 1 &&
    beforeBoards.every((board) => afterBoards.some((after) => JSON.stringify(after) === JSON.stringify(board))));
  const emptyAgain = await call('open_tasklane', { projectDir: emptyRepo });
  check('空仓库重复打开复用项目看板', emptyAgain.result?.structuredContent?.lockedBoardId === emptyData?.lockedBoardId);
  const emptyRegistered = await call('board_create', { repo: emptyRepo });
  const emptyBoard = JSON.parse(emptyRegistered.result?.content?.[0]?.text ?? '{}').board;
  check('显式登记空仓库也复用同一看板', emptyBoard?.id === emptyData?.lockedBoardId);
  const emptyCreated = await call('task_create', { boardId: emptyData?.lockedBoardId, title: '首次提交前整理项目任务' });
  const emptyTask = JSON.parse(emptyCreated.result?.content?.[0]?.text ?? '{}').task;
  check('空仓库任务归属项目看板', emptyTask?.boardId === emptyData?.lockedBoardId);
  const emptyMoved = await call('task_move', { id: emptyTask?.id, boardId: emptyData?.lockedBoardId, status: 'ready' });
  check('首次提交前可人工流转任务', JSON.parse(emptyMoved.result?.content?.[0]?.text ?? '{}').task?.status === 'ready');
  const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd: emptyRepo, stdio: 'pipe',
  });
  check('打开看板和管理任务不创建 Git 提交', head.status === 1);

  const blank = await call('open_tasklane', { projectDir: '   ' });
  const bd = blank.result?._meta?.widgetData ?? blank.result?.structuredContent;
  check(
    '空白 projectDir 被拒绝（不误触发全局模式）',
    blank.result?.isError === true && /projectDir/.test(blank.result?.content?.[0]?.text ?? ''),
  );
  check('空白路径错误结果同样带 widget 标识', bd?.widget === 'tasklane-board' && bd?.mode === 'project');

  const relative = await call('open_tasklane', { projectDir: 'some/relative/path' });
  const rd = relative.result?._meta?.widgetData ?? relative.result?.structuredContent;
  check(
    '相对路径被拒绝',
    relative.result?.isError === true && /绝对路径/.test(relative.result?.content?.[0]?.text ?? ''),
  );
  check('相对路径错误结果同样带 widget 标识', rd?.widget === 'tasklane-board' && rd?.mode === 'project');

  const badBranch = await call('open_tasklane', { projectDir: repoP, baseBranch: 'no-such-branch' });
  const bbd = badBranch.result?._meta?.widgetData ?? badBranch.result?.structuredContent;
  check(
    '已登记仓库忽略后续 baseBranch（幂等不覆盖基线）',
    badBranch.result?.isError !== true && bbd?.lockedBoardId === pd?.lockedBoardId && bbd?.repoRoot === realRepoP,
  );
  const repoQ = mkdtempSync(path.join(tmpdir(), 'ck-plugin-repoq-'));
  {
    const g = (args) => execFileSync('git', args, { cwd: repoQ }).toString().trim();
    g(['init', '-q', '-b', 'trunk']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(path.join(repoQ, 'base.txt'), 'q\n');
    g(['add', '.']);
    g(['commit', '-qm', 'init']);
  }
  const qDefault = await call('open_tasklane', { projectDir: repoQ });
  const qd = qDefault.result?._meta?.widgetData ?? qDefault.result?.structuredContent;
  check(
    '未登记仓库默认基线 main 不存在时明确报错（不创建错误绑定）',
    qDefault.result?.isError === true && /main/.test(qDefault.result?.content?.[0]?.text ?? '') && qd?.widget === 'tasklane-board',
  );
  const qTrunk = await call('open_tasklane', { projectDir: repoQ, baseBranch: 'trunk' });
  const qtd = qTrunk.result?._meta?.widgetData ?? qTrunk.result?.structuredContent;
  check(
    '显式 baseBranch=trunk 注册成功',
    qtd?.mode === 'project' && Boolean(qtd?.lockedBoardId) && qtd?.lockedBoardId !== pd?.lockedBoardId,
  );

  /* ---------- 项目模式与板面工具共享数据 ---------- */
  const created = await call('task_create', { title: '插件项目模式任务', boardId: pd?.lockedBoardId });
  const payload = JSON.parse(created.result?.content?.[0]?.text ?? '{}');
  const task = payload.task ?? payload;
  check('task_create 归属锁定看板', task.boardId === pd?.lockedBoardId, JSON.stringify(payload));
  const boardsRes = await call('board_list');
  const boardsList = JSON.parse(boardsRes.result?.content?.[0]?.text ?? '{}').boards ?? [];
  const locked = boardsList.find((b) => b.id === pd?.lockedBoardId);
  check('board_list 计数包含项目模式创建的任务', locked?.total === 1, JSON.stringify(boardsList.map((b) => [b.id, b.total])));

  // 临时仓库中的真实协议链：确认回执关联卡片资源，且携带当前执行的只读快照。
  const requested = await call('task_execution', { id: task.id, boardId: pd.lockedBoardId,
    action: 'request', requestAction: 'start', requestId: 'inline-report-request', workspaceMode: 'project',
    hostId: 'fixture-host', receiverThreadId: 'fixture-receiver' });
  const receipt = { id: task.id, boardId: pd.lockedBoardId, requestId: 'inline-report-request',
    runId: requested.result?.structuredContent?.request?.runId };
  const binding = { ...receipt, claimId: 'inline-report-claim', hostId: 'fixture-host',
    threadId: 'fixture-thread', workspacePath: realRepoP, workspaceOwner: 'user', branch: 'main' };
  await call('task_execution', { action: 'claim', ...receipt, claimId: binding.claimId });
  await call('task_execution', { action: 'bind', ...binding, phase: 'created' });
  await call('task_execution', { action: 'bind', ...binding, phase: 'bound' });
  for (const state of ['running', 'completed']) {
    const reported = await call('task_execution', { action: 'report', ...receipt, hostId: binding.hostId,
      threadId: binding.threadId, reportId: `inline-report-${state}`, state, activity: `协议检查 ${state}` });
    const data = reported.result?.structuredContent;
    check(`${state} 回执只关联卡片快照，不复用看板打开结果`,
      reported.result?.isError !== true && reported.result?._meta?.['openai/outputTemplate'] === reportUri &&
      data?.presentation === 'report-card' && data.reportCard?.taskId === task.id &&
      data.reportCard?.title === task.title && data.reportCard?.state === state &&
      data.lockedBoardId === pd.lockedBoardId && data.projectDir === realRepoP);
  }

  const resources = await request('resources/list', {});
  const uris = (resources.result?.resources ?? []).map((r) => r.uri);
  check('resources/list exposes widget uri', uris.includes(meta.ui?.resourceUri), uris.join(', '));
  const reportResource = (resources.result?.resources ?? []).find((r) => r.uri === reportUri);
  check('报告资源默认 inline，用户点击才允许 fullscreen',
    JSON.stringify(reportResource?._meta?.['openai/ui']?.availableDisplayModes) === '["inline","fullscreen"]' &&
    reportResource?._meta?.['openai/ui']?.preferredDisplayMode === 'inline');
  const reportRead = await request('resources/read', { uri: reportUri });
  const reportContent = reportRead.result?.contents?.[0];
  check('报告 HTML 独立卡片入口与 inline 模式，保留 SDK 桥',
    reportContent?.mimeType === 'text/html;profile=mcp-app' &&
    reportContent?._meta?.['openai/ui']?.preferredDisplayMode === 'inline' &&
    reportContent?.text?.includes('globalThis.__TASKLANE_REPORT_CARD__=true;') &&
    reportContent?.text?.includes('__KANBAN_MCP_APPS__'));
  const resource = (resources.result?.resources ?? []).find((r) => r.uri === meta.ui?.resourceUri);
  check('资源列表声明应用面板显示模式',
    JSON.stringify(resource?._meta?.['openai/ui']?.availableDisplayModes) === '["fullscreen"]' &&
    resource?._meta?.['openai/ui']?.preferredDisplayMode === 'fullscreen');

  const read = await request('resources/read', { uri: meta.ui?.resourceUri });
  const content = read.result?.contents?.[0];
  check('widget mimeType is mcp-app html', content?.mimeType === 'text/html;profile=mcp-app', content?.mimeType);
  check('资源内容声明应用面板显示模式',
    JSON.stringify(content?._meta?.['openai/ui']?.availableDisplayModes) === '["fullscreen"]' &&
    content?._meta?.['openai/ui']?.preferredDisplayMode === 'fullscreen');
  check('widget html injects MCP Apps global', content?.text?.includes('__KANBAN_MCP_APPS__') === true);
  check('widget html bundles board UI', content?.text?.includes('新建任务') === true || /Kanban|board/i.test(content?.text ?? ''));
  check('widget html bundles project-mode lock UI', content?.text?.includes('项目看板打开失败') === true);

  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'plugins/tasklane/.codex-plugin/plugin.json'), 'utf8'));
  const marketplace = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
  check('市场、插件与实际服务版本一致', manifest.version === '0.3.20' && serverInfo.version === manifest.version && marketplace.plugins.find((plugin) => plugin.name === 'tasklane')?.version === manifest.version);
  const skillPath = path.join(ROOT, 'plugins/tasklane', manifest.skills ?? '__missing_skills__', 'open-tasklane/SKILL.md');
  check('插件声明并打包打开技能', manifest.skills === './skills/' && readFileSync(skillPath, 'utf8').startsWith('---\n'));
  const nativeSkillPath = path.join(ROOT, 'plugins/tasklane', manifest.skills, 'native-execution/SKILL.md');
  check('面板和技能按任务 ID 直接执行，绑定与回执交给执行会话', content?.text?.includes('并用 TaskLane 工具把执行状态和结果更新到看板') === true &&
    content?.text?.includes('创建发起后本次操作即结束') === true &&
    content?.text?.includes('不保存绑定、不移动看板列') === true &&
    readFileSync(nativeSkillPath, 'utf8').includes('Execute the designated task') &&
    readFileSync(nativeSkillPath, 'utf8').includes('CODEX_THREAD_ID') &&
    !content?.text?.includes('callbackThreadId') && !readFileSync(nativeSkillPath, 'utf8').includes('callbackThreadId'));
  check('插件打包原生执行技能及禁止兜底约束',
    readFileSync(nativeSkillPath, 'utf8').includes('task_execution action=report') &&
    readFileSync(nativeSkillPath, 'utf8').includes('reliable interrupt route is unavailable'));
  check('打开工具不要求独立原生能力声明', !openTool.inputSchema?.properties?.nativeExecution &&
    widgetData?.nativeExecution === undefined && pd?.nativeExecution === undefined);
  const hostInfo = await call('tasklane_host_info', { mcpClient: { name: 'codex-mcp-client', version: 'fake' } });
  check('面板重载可读取实际客户端，调用参数不能伪造',
    hostInfo.result?.structuredContent?.mcpClient?.name === 'verify-plugin' &&
    hostInfo.result?.structuredContent?.mcpClient?.version === '0.0.0');
  check('身份读取不生成新面板、不写任务', !hostInfo.result?._meta?.['openai/outputTemplate']);

  child.kill();
  console.log(failed === 0 ? '\nplugin smoke: ALL PASS' : `\nplugin smoke: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('plugin smoke error:', err.message);
  child.kill();
  process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyRepo, { recursive: true, force: true });
}

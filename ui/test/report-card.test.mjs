import test from 'node:test';
import assert from 'node:assert/strict';
// 纯字段组装器：无外部依赖，直接源码导入（独立模式测试，不经插件打包）
import { reportWidgetData, reportWidgetHtml } from '../../extension/src/report-card.mjs';

const boardHome = '/home/.tasklane';
const store = { getBoard: (id) => (id === 'board-1' ? { id: 'board-1', repo: '/repo/main' } : undefined) };
const chainResult = (task, request) => ({ task, request });

test('报告资源在任何应用脚本前初始化卡片，模板异常时拒绝回退看板', () => {
  const html = reportWidgetHtml('<html><HEAD data-theme="dark"><script>loadApp()</script></HEAD></html>');
  assert.ok(html.indexOf('globalThis.__TASKLANE_REPORT_CARD__=true;') < html.indexOf('loadApp()'));
  assert.ok(html.includes("document.documentElement.dataset.reportCard='true'"));
  assert.throws(() => reportWidgetHtml('<html><body><script>loadApp()</script></body></html>'), /缺少 head/);
});

test('报告卡片字段：看板仓库 + 绑定工作区优先，并回传实际握手客户端', () => {
  const data = reportWidgetData({
    result: chainResult(
      { id: 'TASK-129', boardId: 'board-1', executionBinding: { workspacePath: '/repo/main/.worktrees/TASK-129' } },
      { repo: '/repo/ignored' },
    ),
    boardHome,
    store,
    clientVersion: () => ({ name: 'codex-mcp-client', version: '0.155.0' }),
  });
  assert.deepEqual(data, {
    version: 2,
    widget: 'tasklane-board',
    title: 'TaskLane',
    rendering: 'native-widget',
    mode: 'project',
    boardHome,
    lockedBoardId: 'board-1',
    repoRoot: '/repo/main',
    projectDir: '/repo/main/.worktrees/TASK-129',
    taskId: 'TASK-129',
    presentation: 'report-card',
    reportCard: { taskId: 'TASK-129', title: 'TASK-129', priority: 'P2', state: 'idle', activity: undefined, updatedAt: '' },
    mcpClient: { name: 'codex-mcp-client', version: '0.155.0' },
  });
});

test('报告卡片字段：看板缺仓库回退请求仓库，再回退绑定工作区', () => {
  const fallbackRequest = reportWidgetData({
    result: chainResult({ id: 'TASK-2', boardId: 'board-x' }, { repo: '/repo/request' }),
    boardHome,
    store,
  });
  assert.equal(fallbackRequest.repoRoot, '/repo/request');
  assert.equal(fallbackRequest.projectDir, '/repo/request');

  const fallbackBinding = reportWidgetData({
    result: chainResult({ id: 'TASK-2', boardId: 'board-x', executionBinding: { workspacePath: '/wt' } }, {}),
    boardHome,
    store,
  });
  assert.equal(fallbackBinding.repoRoot, '/wt');
  assert.equal(fallbackBinding.projectDir, '/wt');
});

test('报告卡片字段：无法解析绝对路径时返回 null，不阻塞回执', () => {
  const data = reportWidgetData({
    result: chainResult({ id: 'TASK-2', boardId: 'board-x', executionBinding: { workspacePath: 'relative/path' } }, {}),
    boardHome,
    store,
  });
  assert.equal(data, null);
});

test('报告卡片字段：缺少任务/请求结果不组装；未握手不附 mcpClient', () => {
  assert.equal(reportWidgetData({ result: {}, boardHome, store }), null);
  assert.equal(reportWidgetData({ result: chainResult({ id: 'TASK-2', boardId: 'b' }, null), boardHome, store }), null);
  assert.equal(reportWidgetData({ result: chainResult(null, { repo: '/repo' }), boardHome, store }), null);
  const noPeer = reportWidgetData({
    result: chainResult({ id: 'TASK-2', boardId: 'board-1' }, { repo: '/repo/other' }),
    boardHome,
    store,
  });
  assert.equal(noPeer.mcpClient, undefined);
  assert.equal(noPeer.taskId, 'TASK-2');
});

test('报告卡片只读快照：非 Git 目录与当前回执状态，不触发详情打开', () => {
  const data = reportWidgetData({
    result: chainResult({ id: 'TASK-110', boardId: 'plain', title: '非 Git 验收', priority: 'P3',
      execution: { state: 'completed', activity: '只读检查完成', updatedAt: '2026-10-06T10:35:36.004Z' } },
    { purpose: 'implementation', status: 'completed' }),
    boardHome, store: { getBoard: () => ({ repo: null, projectDir: '/plain-project' }) },
  });
  assert.equal(data.presentation, 'report-card');
  assert.equal(data.repoRoot, '/plain-project');
  assert.equal(data.projectDir, '/plain-project');
  assert.deepEqual(data.reportCard, { taskId: 'TASK-110', title: '非 Git 验收', priority: 'P3',
    state: 'completed', activity: '只读检查完成', updatedAt: '2026-10-06T10:35:36.004Z' });
});

test('独立验收回执使用 reviewExecution 快照与 reviewBinding 工作区', () => {
  const data = reportWidgetData({
    result: chainResult({ id: 'TASK-111', boardId: 'board-1', title: '独立验收',
      execution: { state: 'completed' }, executionBinding: { workspacePath: '/implementation' },
      reviewExecution: { state: 'running', activity: '正在复查', updatedAt: '2026-10-06T11:00:00.000Z' },
      reviewBinding: { workspacePath: '/review' } }, { purpose: 'review', status: 'running' }),
    boardHome, store,
  });
  assert.equal(data.reportCard.state, 'running');
  assert.equal(data.reportCard.activity, '正在复查');
  assert.equal(data.projectDir, '/review');
});

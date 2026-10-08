import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'tasklane-inline-report-'));
const hookMock = `
  const fixture = () => globalThis.__reportHooks;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  export function useState(initial) {
    const f = fixture(), i = f.index++;
    if (!(i in f.slots)) f.slots[i] = typeof initial === 'function' ? initial() : initial;
    return [f.slots[i], value => { f.slots[i] = typeof value === 'function' ? value(f.slots[i]) : value; f.dirty = true; }];
  }
  export function useRef(initial) { const f = fixture(), i = f.index++; return f.slots[i] ??= { current: initial }; }
  export function useMemo(fn, deps) {
    const f = fixture(), i = f.index++, old = f.slots[i];
    if (!old || !same(old.deps, deps)) f.slots[i] = { deps, value: fn() };
    return f.slots[i].value;
  }
  export function useCallback(fn, deps) { return useMemo(() => fn, deps); }
  export function useEffect(fn, deps) {
    const f = fixture(), i = f.index++, old = f.slots[i];
    if (!old || !same(old.deps, deps)) { f.slots[i] = { deps }; f.effects.push(fn); }
  }
  export function createContext() { return { Provider: 'provider' }; }
  export function useContext() { return fixture().value; }
  export function jsx(type, props) { return { type, props }; }
  export const jsxs = jsx;
`;

await build({
  stdin: { contents: "export * from './src/mcp/appsClient'; export { BoardProvider } from './src/state/BoardContext';",
    resolveDir: path.resolve('ui'), loader: 'ts' },
  outfile: path.join(dir, 'provider.mjs'), bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
  plugins: [{ name: '报告状态 Hook 测试', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, () => ({ path: 'hooks', namespace: 'fixture' }));
    builder.onResolve({ filter: /\/i18n$/ }, () => ({ path: 'i18n', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({
      contents: name === 'hooks' ? hookMock : 'export function useLang() { return { t: key => key }; }', loader: 'js',
    }));
  } }],
});

globalThis.localStorage = { getItem: () => 'zh', setItem() {} };
globalThis.navigator ??= { language: 'zh-CN' };
globalThis.window = { name: '' };
const { McpAppsClient, BoardProvider } = await import(pathToFileURL(path.join(dir, 'provider.mjs')).href);
await build({
  stdin: { contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
    import App from './src/App'; import { ExecutionReportCard } from './src/components/ExecutionReportCard';
    export function renderApp(board) { globalThis.__reportView = board; return renderToStaticMarkup(createElement(App)); }
    export function cardTree(board) { globalThis.__reportView = board; return ExecutionReportCard(); }`,
    resolveDir: path.resolve('ui'), loader: 'ts' },
  outfile: path.join(dir, 'view.mjs'), bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  plugins: [{ name: '报告展示测试', setup(builder) {
    builder.onResolve({ filter: /BoardContext$|\/i18n$|\/components\// }, ({ path: name }) => {
      const key = name.endsWith('/i18n') ? 'i18n' : name.split('/').at(-1);
      if (key === 'ExecutionReportCard') return;
      return { path: key, namespace: 'view-fixture' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'view-fixture' }, ({ path: name }) => {
      let contents;
      if (name === 'BoardContext') contents = 'export const useBoard = () => globalThis.__reportView; export const BoardProvider = p => p.children;';
      else if (name === 'i18n') contents = 'export const useLang = () => ({ t: key => key }); export const LangProvider = p => p.children;';
      else if (name === 'icons') contents = 'export const PlusIcon = () => null;';
      else contents = `export function ${name}() { return ${JSON.stringify(name)}; }`;
      return { contents, loader: 'js' };
    });
  } }],
});
const { renderApp, cardTree } = await import(pathToFileURL(path.join(dir, 'view.mjs')).href);
globalThis.matchMedia = () => ({ matches: false });
const originalInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const context = { widget: 'tasklane-board', mode: 'project', projectDir: '/plain', repoRoot: '/plain', lockedBoardId: 'plain-board',
  taskId: 'TASK-110', presentation: 'report-card', reportCard: { taskId: 'TASK-110', title: '验收会话卡片',
    priority: 'P2', state: 'running', activity: '正在核验目录', updatedAt: '2026-10-06T10:00:00.000Z' } };
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({ displayModes = ['inline', 'fullscreen'], result = { mode: 'fullscreen' }, request, resource = true, cache = '' } = {}) {
  let app;
  window.name = cache;
  globalThis.__TASKLANE_REPORT_CARD__ = resource;
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.__reportHooks = { slots: [], index: 0, effects: [], dirty: true };
  class FakeApp {
    constructor(info, capabilities) { app = this; this.info = info; this.capabilities = capabilities; this.calls = []; this.displayCalls = []; }
    async connect() {}
    getHostVersion() { return { name: 'OpenAI MCP Apps', version: 'test' }; }
    getHostCapabilities() { return {}; }
    getHostContext() { return { availableDisplayModes: displayModes }; }
    async callServerTool(args) {
      this.calls.push(args);
      if (args.name === 'board_list') return { structuredContent: { boards: [{ id: 'plain-board', name: '非 Git 项目' }] } };
      if (args.name === 'task_list') return { structuredContent: { tasks: [] } };
      if (args.name === 'task_get') return { structuredContent: { task: { id: args.arguments.id, boardId: 'plain-board' }, timeline: [] } };
      return { structuredContent: { mcpClient: { name: 'codex-mcp-client', version: 'test' } } };
    }
    async requestDisplayMode(args) { this.displayCalls.push(args); return request ? request(args) : result; }
  }
  globalThis.__KANBAN_MCP_APPS__ = { App: FakeApp };
  return { get app() { return app; } };
}

async function renderProvider() {
  for (let n = 0; n < 20; n++) {
    const f = globalThis.__reportHooks;
    if (f.dirty) {
      f.index = 0; f.dirty = false;
      f.value = BoardProvider({ children: null }).props.value;
      for (const effect of f.effects.splice(0)) effect();
    }
    await tick();
    if (!f.dirty && !f.effects.length) return f.value;
  }
  throw new Error('报告测试状态未收敛');
}

test.after(() => {
  globalThis.setInterval = originalInterval;
  globalThis.clearInterval = originalClearInterval;
  delete globalThis.__KANBAN_MCP_APPS__;
  delete globalThis.__TASKLANE_REPORT_CARD__;
  delete globalThis.__reportHooks;
});

test('报告初始与两次回执均只显示卡片；用户点击后才请求 fullscreen 并读取详情', async () => {
  const instance = setup();
  let board = await renderProvider();
  assert.equal(board.reportCardVisible, true);
  assert.equal(board.reportCard, null);
  for (const state of ['running', 'completed']) {
    instance.app.ontoolresult({ structuredContent: { ...context, reportCard: { ...context.reportCard, state } } });
    board = await renderProvider();
    assert.equal(board.reportCard.state, state);
    assert.equal(board.reportCardVisible, true);
    assert.equal(board.detailId, null);
  }
  assert.deepEqual(instance.app.capabilities.availableDisplayModes, ['inline', 'fullscreen']);
  assert.equal(instance.app.calls.some(call => ['board_list', 'task_list', 'task_get'].includes(call.name)), false);
  assert.equal(instance.app.displayCalls.length, 0);
  await board.openReportDetail();
  board = await renderProvider();
  assert.deepEqual(instance.app.displayCalls, [{ mode: 'fullscreen' }]);
  assert.equal(board.reportCardVisible, false);
  assert.equal(board.detailId, 'TASK-110');
  assert.equal(board.detail.task.id, 'TASK-110');
  assert.equal(board.boardId, 'plain-board');
  // fullscreen/主题通知保留已确认范围，不自动触发新的展示请求。
  instance.app.onhostcontextchanged({ displayMode: 'fullscreen', theme: 'dark' });
  board = await renderProvider();
  assert.equal(board.projectCtx.lockedBoardId, 'plain-board');
  assert.equal(instance.app.displayCalls.length, 1);
  instance.app.onhostcontextchanged({ displayMode: 'inline' });
  board = await renderProvider();
  assert.equal(board.reportCardVisible, true);
  assert.equal(board.detailId, null);
});

test('宿主不支持、拒绝或返回 inline 时保留卡片和范围，不读任务详情', async () => {
  for (const options of [{ displayModes: ['inline'] }, { request: async () => { throw new Error('拒绝'); } }, { result: { mode: 'inline' } }]) {
    const instance = setup(options);
    await renderProvider();
    instance.app.ontoolresult({ structuredContent: context });
    let board = await renderProvider();
    await board.openReportDetail();
    board = await renderProvider();
    assert.equal(board.reportCardVisible, true);
    assert.equal(board.detailId, null);
    assert.equal(board.projectCtx.lockedBoardId, 'plain-board');
    assert.ok(board.reportCardError);
    assert.equal(instance.app.calls.some(call => call.name === 'task_get'), false);
    assert.equal(instance.app.displayCalls.length, options.displayModes ? 0 : 1);
  }
});

test('点击等待期间报告更新，迟到 fullscreen 不展开旧任务', async () => {
  let finish;
  const instance = setup({ request: () => new Promise(resolve => { finish = resolve; }) });
  await renderProvider();
  instance.app.ontoolresult({ structuredContent: context });
  let board = await renderProvider();
  const opening = board.openReportDetail();
  await board.openReportDetail();
  assert.equal(instance.app.displayCalls.length, 1, '连续点击不得重复请求宿主展开');
  await tick();
  const next = { ...context, taskId: 'TASK-111', reportCard: { ...context.reportCard, taskId: 'TASK-111', state: 'completed' } };
  instance.app.ontoolresult({ structuredContent: next });
  finish({ mode: 'fullscreen' });
  await opening;
  board = await renderProvider();
  assert.equal(board.reportCardVisible, true);
  assert.equal(board.reportCard.taskId, 'TASK-111');
  assert.equal(board.detailId, null);
  assert.equal(instance.app.calls.some(call => call.name === 'task_get'), false);
});

test('会话只渲染报告快照与详情按钮；完整看板仅在获准展开后渲染', () => {
  let clicks = 0;
  const fixture = { reportCardVisible: true, reportCard: { ...context.reportCard, title: '<script>危险标题</script>' },
    reportCardError: null, reportCardOpening: false, conn: 'connected', openReportDetail: () => { clicks++; } };
  const html = renderApp(fixture);
  assert.ok(html.includes('execution-report-card'));
  assert.ok(html.includes('TASK-110'));
  assert.ok(html.includes('native.status.running'));
  assert.ok(html.includes('reportCard.openDetail'));
  assert.ok(html.includes('&lt;script&gt;危险标题&lt;/script&gt;'));
  assert.ok(!html.includes('TaskList'));
  assert.ok(!html.includes('AppHeader'));
  assert.equal(clicks, 0);
  const findButton = node => {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'button') return node;
    const children = node.props?.children;
    return (Array.isArray(children) ? children.flat(Infinity) : [children]).map(findButton).find(Boolean);
  };
  findButton(cardTree(fixture)).props.onClick();
  assert.equal(clicks, 1);
  for (const patch of [{ conn: 'disconnected' }, { reportCardOpening: true }]) {
    assert.ok(/<button[^>]*disabled/.test(renderApp({ ...fixture, ...patch })));
  }
  const rejected = renderApp({ ...fixture, reportCardError: '宿主拒绝打开' });
  assert.ok(rejected.includes('role="alert"'));
  assert.ok(rejected.includes('宿主拒绝打开'));
  const waiting = renderApp({ ...fixture, reportCard: null });
  assert.ok(waiting.includes('reportCard.loading'));
  assert.ok(!waiting.includes('TaskList'));
  const expanded = renderApp({ ...fixture, reportCardVisible: false });
  assert.ok(expanded.includes('TaskList'));
  assert.ok(expanded.includes('AppHeader'));
  assert.ok(!expanded.includes('execution-report-card'));
});

test('缓存恢复报告快照仍为卡片，非法快照不回退完整看板；普通入口仍可聚焦', async () => {
  const cached = setup({ cache: `tasklane-ctx:${JSON.stringify(context)}` });
  let board = await renderProvider();
  assert.equal(board.reportCardVisible, true);
  assert.equal(board.reportCard.taskId, 'TASK-110');
  assert.equal(board.detailId, null);
  cached.app.ontoolresult({ structuredContent: context });
  await renderProvider();
  assert.ok(window.name.includes('"presentation":"report-card"'));
  assert.ok(window.name.includes('"reportCard"'));
  for (const patch of [{ taskId: 'TASK-other' }, { state: 'ready' }, { priority: 'P9' }, { title: '' }, { updatedAt: '无效日期' }]) {
    cached.app.ontoolresult({ structuredContent: { ...context, reportCard: { ...context.reportCard, ...patch } } });
    board = await renderProvider();
    assert.equal(board.reportCardVisible, true);
    assert.equal(board.reportCard, null);
    assert.ok(board.reportCardError);
    assert.equal(board.detailId, null);
  }
  const ordinary = setup({ resource: false });
  await renderProvider();
  ordinary.app.ontoolresult({ structuredContent: { ...context, presentation: undefined, reportCard: undefined } });
  board = await renderProvider();
  assert.deepEqual(ordinary.app.capabilities.availableDisplayModes, ['fullscreen']);
  assert.equal(board.reportCardVisible, false);
  assert.equal(board.detailId, 'TASK-110');
  assert.equal(ordinary.app.displayCalls.length, 0);
});

test('连接断开与未知路由通知撤销展开资格，展示通知保留资格', async () => {
  const instance = setup();
  const client = new McpAppsClient();
  client.connect();
  await tick();
  instance.app.ontoolresult({ structuredContent: context });
  const version = client.getSnapshot().contextVersion;
  instance.app.onhostcontextchanged({ displayMode: 'inline', containerDimensions: { width: 320, height: 200 } });
  assert.equal(client.getSnapshot().contextVersion, version);
  await client.expandReportCard(version, 'TASK-110', 'plain-board');
  instance.app.onhostcontextchanged({ receiverThreadId: 'unknown' });
  await assert.rejects(client.expandReportCard(client.getSnapshot().contextVersion, 'TASK-110', 'plain-board'));
  instance.app.ontoolresult({ structuredContent: context });
  instance.app.onclose();
  await assert.rejects(client.expandReportCard(client.getSnapshot().contextVersion, 'TASK-110', 'plain-board'));
});

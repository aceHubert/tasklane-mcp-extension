import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const output = path.join(mkdtempSync(path.join(tmpdir(), 'tasklane-detail-test-')), 'entry.mjs');
const mocks = {
  BoardContext: 'export function useBoard() { return globalThis.__taskDetailFixture.board; }',
  useTaskActions: 'export function useTaskActions() { return globalThis.__taskDetailFixture.actions; }',
  nativeExecution: `export { executionStatusCheckReason } from ${JSON.stringify(path.resolve('ui/src/state/nativeExecution.ts'))}; export function creationModelRequest(task) { return task.executionRequests?.find(r => r.action === "start"); } export function normalizeExecutionModel(value) { return value.trim() || undefined; } export function toModelOptions() { return []; }`,
  i18n: 'export function useLang() { return { t: key => key }; }',
  messages: 'export const translate = key => key; export const statusKey = value => "status." + value; export const eventKey = value => "event." + value; export const execKey = value => "exec." + value;',
  HostConnection: 'export function HostConnection() { return null; }',
};

await build({
  stdin: {
    contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { TaskDetail } from './src/components/TaskDetail'; import { TaskCard } from './src/components/TaskCard'; import { NewTaskForm } from './src/components/NewTaskForm'; export function renderDetail(fixture, inDrawer) { globalThis.__taskDetailFixture = fixture; return renderToStaticMarkup(createElement(TaskDetail, { onClose() {}, inDrawer })); } export function renderCard(fixture) { globalThis.__taskDetailFixture = fixture; return renderToStaticMarkup(createElement(TaskCard, { task: fixture.board.detail.task })); } export function renderNew(fixture) { globalThis.__taskDetailFixture = fixture; return renderToStaticMarkup(createElement(NewTaskForm, { onDone() {} })); }`,
    resolveDir: path.resolve('ui'), loader: 'ts',
  },
  outfile: output, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  plugins: [{
    name: 'detail-fixtures',
    setup(builder) {
      builder.onResolve({ filter: /BoardContext$|useTaskActions$|state\/nativeExecution$|\/i18n$|i18n\/messages$|HostConnection$/ }, ({ path: name }) => {
        const key = name.endsWith('/i18n') ? 'i18n' : name.split('/').at(-1);
        return { path: key, namespace: 'fixture' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ contents: mocks[name], loader: 'js', resolveDir: path.resolve('ui') }));
    },
  }],
});
const { renderDetail, renderCard, renderNew } = await import(pathToFileURL(output).href);

function fixture(state, bound, connected, assignee = 'agent') {
  const task = {
    id: 'TASK-101', boardId: 'default', title: '详情界面回归', status: 'doing', priority: 'P2', assignee,
    execution: { state, sessionId: 'sess-internal' }, executionRequests: [],
    ...(bound ? { executionBinding: { provider: 'codex-desktop', threadId: 'real-thread', hostId: 'host', workspacePath: '/repo', workspaceOwner: 'user', boundAt: '2026-10-04T00:00:00.000Z' } } : {}),
  };
  const noop = () => {};
  return {
    board: { detail: { task, timeline: [] }, conn: connected ? 'connected' : 'disconnected', hostSnapshot: { connected,
      info: { name: 'Codex', version: 'test' }, capabilities: { message: { text: {} } },
      scope: { mode: 'project', lockedBoardId: task.boardId }, contextVersion: 1 }, mutate: noop, call: noop, toast: noop },
    actions: { requests: [], agentName: 'Codex', status: bound ? state : 'unbound', reason: () => null, openReason: null, move: noop, restore: noop, archive: noop, start: noop, continueExecution: noop, openSession: noop },
  };
}

for (const inDrawer of [false, true]) {
  test(`${inDrawer ? '宽抽屉' : '窄栏详情'}不展示消息控制区，保留会话打开与任务字段`, () => {
    for (const state of ['assigned', 'waiting', 'failed', 'running', 'completed']) {
      for (const bound of [false, true]) {
        for (const connected of [false, true]) {
          const html = renderDetail(fixture(state, bound, connected), inDrawer);
          assert.ok(!/native\.(replyText|reply|retry|stop|reason\.stop)/.test(html));
          assert.equal(html.includes('native.open'), bound && connected);
          assert.ok(html.includes('detail.fieldDescription'));
          assert.equal(html.includes('native.workspace'), connected);
          assert.equal(/<select\b[^>]*aria-label="native\.workspace"/.test(html), connected && !bound);
          assert.equal(html.includes('native.model.'), connected || bound);
          assert.equal((html.match(/<textarea\b/g) ?? []).length, 1);
        }
      }
    }
  });
}


test('卡片和详情执行方只读，Human 与 Agent 都不展示独立指派操作', () => {
  for (const assignee of ['human', 'agent']) {
    const data = fixture('assigned', false, true, assignee);
    const cardHtml = renderCard(data);
    assert.ok(!/native\.(start|continue)/.test(cardHtml));
    for (const html of [cardHtml, renderDetail(data, false), renderDetail(data, true)]) {
      assert.ok(!/card\.assignToAgent|detail\.reassignHuman|form\.assignNow/.test(html));
      assert.ok(html.includes(assignee === 'human' ? 'card.human' : 'Codex'));
    }
    assert.ok(renderDetail(data, false).includes('native.start'));
    assert.ok(renderDetail(data, true).includes('native.start'));
  }
});

test('新建表单不提供自动指派，UI 操作层不另行调用 task_assign', () => {
  const html = renderNew(fixture('idle', false, true, 'human'));
  assert.ok(!/form\.assignNow|type="checkbox"/.test(html));
  assert.ok(html.includes('form.plainHint'));
  for (const name of ['components/NewTaskForm.tsx', 'components/TaskCard.tsx', 'components/TaskDetail.tsx', 'state/useTaskActions.ts']) {
    const source = readFileSync(path.resolve('ui/src', name), 'utf8');
    assert.ok(!/task_assign|actions\.assign\(|assignHuman/.test(source), name);
  }
});


for (const inDrawer of [false, true]) {
  test(`${inDrawer ? '宽抽屉' : '窄详情'}会话优先显示真实绑定，内部 ID 仅作未绑定回退`, () => {
    const unbound = fixture('idle', false, true);
    const before = structuredClone(unbound.board.detail.task);
    const localHtml = renderDetail(unbound, inDrawer);
    assert.ok(localHtml.includes('sess-internal'));
    assert.ok(localHtml.includes('native.status.unbound'));
    assert.ok(!localHtml.includes('real-thread'));
    assert.ok(!localHtml.includes('codex://threads/sess-internal'));
    assert.deepEqual(unbound.board.detail.task, before);

    for (const status of ['bound', 'running', 'waiting', 'completed']) {
      const bound = fixture('idle', true, true);
      bound.actions.status = status;
      const html = renderDetail(bound, inDrawer);
      assert.ok(html.includes('real-thread'));
      assert.ok(!html.includes('sess-internal'));
      assert.ok(!html.includes('native.status.unbound'));
      assert.equal(bound.board.detail.task.execution.sessionId, 'sess-internal');
    }

    for (const status of ['pending', 'uncertain']) {
      const waiting = fixture('idle', false, true);
      waiting.actions.status = status;
      const html = renderDetail(waiting, inDrawer);
      assert.ok(html.includes('sess-internal'));
      assert.ok(html.includes('native.status.unbound'));
      assert.ok(html.includes(`native.status.${status}`));
    }

    const malformed = fixture('idle', true, true);
    malformed.board.detail.task.executionBinding.threadId = 'creating-placeholder';
    malformed.actions.status = 'unbound';
    const html = renderDetail(malformed, inDrawer);
    assert.ok(html.includes('sess-internal'));
    assert.ok(!html.includes('creating-placeholder'));

    const noId = fixture('idle', false, true);
    delete noId.board.detail.task.execution.sessionId;
    const noIdHtml = renderDetail(noId, inDrawer);
    assert.ok(!noIdHtml.includes('sess-internal'));
    assert.ok(noIdHtml.includes('native.status.unbound'));
    assert.equal(noId.board.detail.task.execution.sessionId, undefined);
  });
}


test('详情仅在已保存真实绑定或完整 created 结果时显示打开会话按钮', () => {
  const renderers = [(data) => renderDetail(data, false), (data) => renderDetail(data, true)];
  for (const render of renderers) {
    for (const threadId of [undefined, '', 'sess-internal', 'client-new-thread:temporary', 'creating-placeholder', 'pending-thread']) {
      const data = fixture('idle', true, true);
      data.board.detail.task.executionBinding.threadId = threadId;
      assert.ok(!render(data).includes('native.open'), String(threadId));
    }
    const internalOnly = fixture('idle', false, true);
    assert.ok(!render(internalOnly).includes('native.open'));

    const createdOnly = fixture('starting', false, true);
    createdOnly.board.detail.task.executionRequests = [{ action: 'start', result: { threadId: 'created-thread', hostId: 'host' } }];
    createdOnly.actions.status = 'pending';
    assert.ok(!render(createdOnly).includes('native.open'));
    createdOnly.board.detail.task.execution.runId = 'created-run';
    createdOnly.board.detail.task.executionRequests[0] = { ...createdOnly.board.detail.task.executionRequests[0], runId: 'created-run',
      result: { threadId: 'created-thread', hostId: 'host', workspacePath: '/wt', workspaceOwner: 'codex' } };
    assert.ok(render(createdOnly).includes('native.open'));
    assert.ok(render(createdOnly).includes('created-thread'));
    assert.ok(!render(createdOnly).includes('sess-internal'));

    const bound = fixture('idle', true, true);
    assert.ok(render(bound).includes('native.open'));
    bound.board.conn = 'disconnected';
    assert.ok(!render(bound).includes('native.open'));
  }
});

for (const inDrawer of [false, true]) {
  test(`${inDrawer ? '宽抽屉' : '窄详情'}blocked 展示原因、真实会话和核对继续，无结果则保留核对入口`, () => {
    const data = fixture('blocked', false, true);
    const request = { requestId: 'blocked-request', runId: 'blocked-run', action: 'start', status: 'blocked', workspaceMode: 'worktree',
      deliveryError: '工作区核验失败', result: { threadId: 'created-real', hostId: 'host', workspacePath: '/wt', workspaceOwner: 'codex' } };
    data.board.detail.task.execution.runId = request.runId;
    data.board.detail.task.executionRequests = [request];
    data.actions.requests = [request];
    data.actions.status = 'blocked';
    const html = renderDetail(data, inDrawer);
    assert.ok(html.includes('native.status.blocked'));
    assert.ok(html.includes('native.blocked.reason'));
    assert.ok(html.includes('created-real'));
    assert.ok(html.includes('native.blocked.continue'));
    assert.ok(html.includes('native.open'));
    assert.ok(html.includes('native.recovery.action'));
    assert.ok(!html.includes('native.start'));
    delete request.result;
    data.actions.reason = () => 'binding';
    const noResult = renderDetail(data, inDrawer);
    assert.ok(noResult.includes('native.blocked.noTarget'));
    assert.ok(!noResult.includes('native.open'));
    assert.match(noResult, /<button\b[^>]*disabled=""[^>]*>native\.blocked\.continue<\/button>/);
    assert.ok(noResult.includes('native.recovery.action'));
  });
}


for (const inDrawer of [false, true]) {
  test(`${inDrawer ? '宽抽屉' : '窄详情'}宿主未连接时隐藏执行控件，已绑定模型保持只读`, () => {
    for (const bound of [false, true]) {
      for (const conn of ['connecting', 'disconnected', 'connected']) {
        const data = fixture('idle', bound, true);
        data.board.conn = conn;
        data.board.hostSnapshot.connected = false;
        data.actions.status = 'pending';
        const html = renderDetail(data, inDrawer);
        assert.ok(!html.includes('native.workspace'));
        assert.equal(html.includes('native.model.'), bound);
        if (bound) {
          assert.ok(html.includes('native.model.created'));
          assert.ok(!/<select\b[^>]*aria-label="native\.model\.label"/.test(html));
        }
        assert.ok(!html.includes('native.ownership'));
        assert.ok(!html.includes('native.start'));
        assert.ok(!html.includes('native.continue'));
        assert.ok(html.includes(bound ? 'real-thread' : 'sess-internal'));
        assert.ok(html.includes('native.status.pending'));
      }
    }
    const reconnected = fixture('idle', false, true);
    const html = renderDetail(reconnected, inDrawer);
    assert.ok(html.includes('native.workspace'));
    assert.ok(html.includes('native.model.label'));
    assert.ok(html.includes('native.start'));
    assert.ok(!html.includes('native.open'));
  });
}

test('卡片在连接、仅 MCP 数据通道或断连时都不展示 Run/继续入口', () => {
  for (const bound of [false, true]) {
    const data = fixture('idle', bound, true);
    data.board.hostSnapshot.connected = false;
    let html = renderCard(data);
    assert.ok(!/native\.(start|continue)/.test(html));
    data.board.hostSnapshot.connected = true;
    data.board.conn = 'disconnected';
    html = renderCard(data);
    assert.ok(!/native\.(start|continue)/.test(html));
    data.board.conn = 'connected';
    assert.ok(!/native\.(start|continue)/.test(renderCard(data)));
  }
});


test('卡片执行方与聊天状态在同一行 tag，不展示独立状态、执行入口或宿主说明', () => {
  for (const assignee of ['human', 'agent']) {
    for (const status of ['unbound', 'bound', 'pending', 'uncertain', 'blocked', 'running', 'waiting', 'failed', 'completed']) {
      for (const connected of [false, true]) {
        const data = fixture('idle', status !== 'unbound', connected, assignee);
        data.actions.status = status;
        data.actions.reason = () => 'unknown';
        const html = renderCard(data);
        const tags = html.match(/<div class="exec card-tags">([\s\S]*?)<\/div>/)?.[1];
        assert.ok(tags, status);
        assert.ok(tags.includes(assignee === 'human' ? 'card.human' : 'Codex'));
        assert.ok(tags.includes(`native.cardStatus.${status}`));
        assert.ok(tags.includes('card-state-tag'));
        assert.equal((tags.match(/class="exec-chip/g) ?? []).length, 2);
        assert.ok(!/native-state|native-reason|native\.(start|continue|open)/.test(html));
        assert.ok(!html.includes('native.reason.unknown'));
        assert.ok(html.includes('card-title'));
        assert.ok(html.includes('TASK-101'));
      }
    }
  }
});

for (const inDrawer of [false, true]) {
  test(`${inDrawer ? '宽抽屉' : '窄详情'}运行、等待及终态均展示会话核对，断连或能力不支持时禁用`, () => {
    for (const state of ['running', 'waiting', 'completed', 'failed', 'rejected', 'uncertain', 'blocked']) {
      const data = fixture(state, true, true);
      const request = { requestId: 'check-request', runId: 'check-run', action: 'start', status: state, workspaceMode: 'project' };
      data.board.detail.task.execution.runId = request.runId;
      data.board.detail.task.executionRequests = [request];
      data.actions.requests = [request];
      const html = renderDetail(data, inDrawer);
      assert.match(html, /<button\b(?![^>]*disabled)[^>]*>native\.recovery\.action<\/button>/, state);
      for (const patch of [{ connected: false }, { capabilities: {} }, { info: { name: 'Unknown', version: 'test' } },
        { scope: { mode: 'project', lockedBoardId: 'different-board' } }]) {
        const original = data.board.hostSnapshot;
        data.board.hostSnapshot = { ...original, ...patch };
        assert.match(renderDetail(data, inDrawer), /<button\b[^>]*disabled=""[^>]*>native\.recovery\.action<\/button>/, state);
        data.board.hostSnapshot = original;
      }
      data.board.detail.task.archivedAt = '2026-10-04T00:00:00.000Z';
      assert.ok(!renderDetail(data, inDrawer).includes('native.recovery.action'));
      delete data.board.detail.task.archivedAt;
      request.status = 'cancelled';
      assert.ok(!renderDetail(data, inDrawer).includes('native.recovery.action'));
    }
  });
}

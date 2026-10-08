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
    board: { board: { id: 'default', repo: '/repo', projectDir: '/repo', repoKey: '/repo/.git' }, detail: { task, timeline: [] }, conn: connected ? 'connected' : 'disconnected', hostSnapshot: { connected,
      info: { name: 'Codex', version: 'test' }, capabilities: { message: { text: {} } },
      scope: { mode: 'project', lockedBoardId: task.boardId }, contextVersion: 1 }, mutate: noop, call: noop, toast: noop },
    actions: { requests: [], agentName: 'Codex', status: bound ? state : 'unbound', reason: () => null, reviewReason: () => null, openReason: null, move: noop, restore: noop, archive: noop, start: noop, continueExecution: noop, startReview: noop, continueReview: noop, continueFix: noop, openSession: noop },
  };
}

test('无项目看板固定只读执行方式，旧工作区字段也不会提供工作区选项', () => {
  for (const inDrawer of [false, true]) {
    for (const worktreePath of [undefined, '/old-worktree']) {
      const data = fixture('idle', false, true);
      data.board.board = { id: 'default', repo: null, projectDir: null, repoKey: null };
      data.board.detail.task.worktreePath = worktreePath;
      const html = renderDetail(data, inDrawer);
      assert.ok(html.includes('native.projectless'));
      assert.ok(!/<select\b[^>]*aria-label="native\.workspace"/.test(html));
      assert.ok(!/<option\b[^>]*value="(?:project|worktree|existing)"/.test(html));
    }
  }
});

test('非 Git 项目只通过工作方式选项限制 worktree，沿用原有说明', () => {
  const data = fixture('idle', false, true);
  data.board.board = { id: 'default', repo: null, projectDir: '/plain-project', repoKey: null };
  const html = renderDetail(data, false);
  assert.ok(html.includes('value="project"'));
  assert.ok(!html.includes('value="worktree"'));
  assert.ok(!html.includes('native.nonGit.note'));
  assert.ok(html.includes('native.ownership'));
});

for (const inDrawer of [false, true]) {
  test(`${inDrawer ? '宽抽屉' : '窄栏详情'}不展示消息控制区，保留会话打开与任务字段`, () => {
    for (const state of ['assigned', 'waiting', 'failed', 'running', 'completed']) {
      for (const bound of [false, true]) {
        for (const connected of [false, true]) {
          const html = renderDetail(fixture(state, bound, connected), inDrawer);
          assert.ok(!/native\.(replyText|reply|retry|stop|reason\.stop)/.test(html));
          assert.equal(html.includes('native.open'), bound && connected);
          assert.ok(html.includes('detail.fieldDescription'));
          assert.ok(html.includes('native.executionSection'));
          assert.equal(html.includes('native.workspace'), connected && !bound);
          assert.equal(/<select\b[^>]*aria-label="native\.workspace"/.test(html), connected && !bound);
          assert.equal(html.includes('native.model.'), connected || bound);
          assert.equal((html.match(/<textarea\b/g) ?? []).length, bound && connected ? 2 : 1);
          assert.equal(html.includes('native.continuePromptLabel'), bound && connected);
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
  test(`${inDrawer ? '宽抽屉' : '窄详情'}blocked 保留原因、真实会话和核对后继续，但隐藏超时核对入口`, (t) => {
    const now = Date.parse('2026-10-05T04:00:00.000Z');
    t.mock.method(Date, 'now', () => now);
    const data = fixture('blocked', false, true);
    const request = { requestId: 'blocked-request', runId: 'blocked-run', action: 'start', status: 'blocked', workspaceMode: 'worktree',
      updatedAt: new Date(now - 10 * 60_000).toISOString(),
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
    assert.ok(!html.includes('native.recovery.action'));
    assert.ok(!html.includes('native.start'));
    delete request.result;
    data.actions.reason = () => 'binding';
    const noResult = renderDetail(data, inDrawer);
    assert.ok(noResult.includes('native.blocked.noTarget'));
    assert.ok(!noResult.includes('native.open'));
    assert.match(noResult, /<button\b[^>]*disabled=""[^>]*>native\.blocked\.continue<\/button>/);
    assert.ok(!noResult.includes('native.recovery.action'));
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
        assert.ok(html.includes('native.executionSection'));
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
  test(`${inDrawer ? '宽抽屉' : '窄详情'}创建链路超过五分钟展示会话核对，断连或能力不支持时禁用`, (t) => {
    const now = Date.parse('2026-10-05T04:00:00.000Z');
    t.mock.method(Date, 'now', () => now);
    for (const status of ['pending', 'delivered', 'claimed', 'created', 'bound']) {
      const data = fixture('starting', true, true);
      const request = { requestId: 'check-request', runId: 'check-run', action: 'start', status, workspaceMode: 'project',
        updatedAt: new Date(now - 5 * 60_000 - 1).toISOString() };
      data.board.detail.task.execution.runId = request.runId;
      data.board.detail.task.executionRequests = [request];
      data.actions.requests = [request];
      data.actions.status = status;
      const html = renderDetail(data, inDrawer);
      assert.match(html, /<button\b(?![^>]*disabled)[^>]*>native\.recovery\.action<\/button>/, status);
      for (const patch of [{ connected: false }, { capabilities: {} }, { info: { name: 'Unknown', version: 'test' } },
        { scope: { mode: 'project', lockedBoardId: 'different-board' } }]) {
        const original = data.board.hostSnapshot;
        data.board.hostSnapshot = { ...original, ...patch };
        assert.match(renderDetail(data, inDrawer), /<button\b[^>]*disabled=""[^>]*>native\.recovery\.action<\/button>/, status);
        data.board.hostSnapshot = original;
      }
      data.board.conn = 'disconnected';
      assert.match(renderDetail(data, inDrawer), /<button\b[^>]*disabled=""[^>]*>native\.recovery\.action<\/button>/, status);
      data.board.conn = 'connected';
      data.board.detail.task.archivedAt = '2026-10-04T00:00:00.000Z';
      assert.ok(!renderDetail(data, inDrawer).includes('native.recovery.action'));
    }
  });

  test(`${inDrawer ? '宽抽屉' : '窄详情'}会话核对严格检查请求状态、更新时间与当前轮次`, (t) => {
    const now = Date.parse('2026-10-05T04:00:00.000Z');
    t.mock.method(Date, 'now', () => now);
    const timeCases = [
      { label: '刚更新', updatedAt: new Date(now).toISOString(), visible: false },
      { label: '未满五分钟', updatedAt: new Date(now - 5 * 60_000 + 1).toISOString(), visible: false },
      { label: '恰好五分钟', updatedAt: new Date(now - 5 * 60_000).toISOString(), visible: false },
      { label: '超过五分钟', updatedAt: new Date(now - 5 * 60_000 - 1).toISOString(), visible: true },
      { label: '无效日期', updatedAt: 'invalid', visible: false },
      { label: '缺少日期', updatedAt: undefined, visible: false },
      { label: '未来日期', updatedAt: new Date(now + 1).toISOString(), visible: false },
    ];
    for (const status of ['pending', 'delivered', 'claimed', 'created', 'bound']) {
      const data = fixture('starting', false, true);
      const request = { requestId: 'check-request', runId: 'check-run', action: 'start', status, workspaceMode: 'project' };
      data.board.detail.task.execution.runId = request.runId;
      data.board.detail.task.executionRequests = [request];
      data.actions.requests = [request];
      data.actions.status = status;
      for (const { label, updatedAt, visible } of timeCases) {
        request.updatedAt = updatedAt;
        assert.equal(renderDetail(data, inDrawer).includes('native.recovery.action'), visible, `${status}: ${label}`);
      }
      request.updatedAt = new Date(now - 10 * 60_000).toISOString();
      data.board.detail.task.execution.runId = 'different-run';
      assert.ok(!renderDetail(data, inDrawer).includes('native.recovery.action'), `${status}: 旧轮次`);
    }
    for (const status of ['blocked', 'uncertain', 'running', 'waiting', 'completed', 'failed', 'rejected', 'cancelled']) {
      const data = fixture(status, true, true);
      const request = { requestId: 'check-request', runId: 'check-run', action: 'start', status, workspaceMode: 'project',
        updatedAt: new Date(now - 10 * 60_000).toISOString() };
      data.board.detail.task.execution.runId = request.runId;
      data.board.detail.task.executionRequests = [request];
      data.actions.requests = [request];
      data.actions.status = status;
      assert.ok(!renderDetail(data, inDrawer).includes('native.recovery.action'), status);
    }
  });
}

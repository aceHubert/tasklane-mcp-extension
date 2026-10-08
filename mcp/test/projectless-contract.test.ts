import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BoardEngine,
  GitService,
  JsonFileBoardStore,
  type Board,
  type RepoValidation,
} from '@tasklane/core';
import * as h from '../src/handlers.js';

/**
 * 无项目执行与非 Git 项目的 MCP 契约：直接调用纯 handler 层，
 * 工具层 zod 枚举（workspaceMode 含 projectless）由 SDK 输入校验保证。
 */
class StubGitService extends GitService {
  private readonly dirs = new Map<string, RepoValidation | null>();

  setDir(dir: string, identity: RepoValidation | null): void {
    this.dirs.set(realpathSync(dir), identity);
  }

  constructor() {
    super(true);
  }

  override async probeRepo(dirInput: string): Promise<RepoValidation | null> {
    const identity = this.dirs.get(realpathSync(dirInput));
    if (identity === undefined) {
      throw new Error(`未配置桩目录: ${dirInput}`);
    }
    return identity ? { ...identity } : null;
  }

  override async identifyRepo(repoInput: string): Promise<RepoValidation> {
    const identity = await this.probeRepo(repoInput);
    if (!identity) throw new Error(`不是 Git 仓库: ${repoInput}`);
    return identity;
  }

  override async validateRepoForBoard(repoInput: string): Promise<RepoValidation> {
    const identity = await this.probeRepo(repoInput);
    if (!identity) throw new Error(`不是 Git 仓库: ${repoInput}`);
    return identity;
  }
}

function makeEngine(git: GitService): { engine: BoardEngine; store: JsonFileBoardStore } {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tl-projectless-mcp-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  return { engine: new BoardEngine(store, git), store };
}

function projectlessBoard(store: JsonFileBoardStore): Board {
  const board = store.boards.find((b) => b.id === 'default')!;
  assert.equal(board.repo ?? null, null);
  assert.equal(board.projectDir ?? null, null);
  return board;
}

test('契约：无项目看板 task_execution_request(projectless) → repo 为 null；绑定不带工作区', async () => {
  const git = new StubGitService();
  const { engine, store } = makeEngine(git);
  const board = projectlessBoard(store);
  const { task } = await h.taskCreate(engine, { title: '无项目契约', boardId: board.id, status: 'ready' });

  const result = await h.taskExecution(engine, { action: 'request',
    id: task.id, boardId: board.id, requestId: 'req-p1', requestAction: 'start', workspaceMode: 'projectless',
    hostId: 'codex-host-p', receiverThreadId: 'receiver-p',
  });
  assert.equal(result.created, true);
  assert.equal(result.request.repo, null);
  assert.equal(result.request.workspaceMode, 'projectless');

  await h.taskExecution(engine, { action: 'claim',
    id: task.id, boardId: board.id, requestId: 'req-p1', runId: result.request.runId, claimId: 'claim-p',
    hostId: 'codex-host-p', receiverThreadId: 'receiver-p',
  });
  const created = await h.taskExecution(engine, { action: 'bind',
    id: task.id, boardId: board.id, requestId: 'req-p1', runId: result.request.runId, claimId: 'claim-p',
    phase: 'created', threadId: 'native-thread-p', hostId: 'codex-host-p',
  });
  assert.equal(created.request.result?.workspacePath, undefined);
  const bound = await h.taskExecution(engine, { action: 'bind',
    id: task.id, boardId: board.id, requestId: 'req-p1', runId: result.request.runId, claimId: 'claim-p',
    phase: 'bound', threadId: 'native-thread-p', hostId: 'codex-host-p',
  });
  assert.equal(bound.task.executionBinding?.workspacePath, undefined);
  const running = await h.taskExecution(engine, { action: 'report',
    id: task.id, boardId: board.id, requestId: 'req-p1', runId: result.request.runId,
    threadId: 'native-thread-p', hostId: 'codex-host-p', reportId: 'rep-p1', state: 'running',
  });
  assert.equal(running.task.execution.state, 'running');
});

test('契约：无项目看板拒绝 project/worktree 与 review；携带工作区字段的绑定被拒绝', async () => {
  const git = new StubGitService();
  const { engine, store } = makeEngine(git);
  const board = projectlessBoard(store);
  const { task } = await h.taskCreate(engine, { title: '无项目拒绝', boardId: board.id, status: 'ready' });

  for (const workspaceMode of ['project', 'worktree'] as const) {
    await assert.rejects(
      h.taskExecution(engine, { action: 'request',
        id: task.id, boardId: board.id, requestId: `req-${workspaceMode}`, requestAction: 'start', workspaceMode,
      }),
      (err: Error) => /无项目|worktree/.test(err.message),
    );
  }
  const started = await h.taskExecution(engine, { action: 'request',
    id: task.id, boardId: board.id, requestId: 'req-p2', requestAction: 'start', workspaceMode: 'projectless',
  });
  await assert.rejects(
    h.taskExecution(engine, { action: 'request',
      id: task.id, boardId: board.id, requestId: 'req-review', requestAction: 'start',
      workspaceMode: 'existing', purpose: 'review',
    }),
    (err: Error) => /不参与 Review/.test(err.message),
  );
  await h.taskExecution(engine, { action: 'claim',
    id: task.id, boardId: board.id, requestId: 'req-p2', runId: started.request.runId, claimId: 'claim-p',
    hostId: 'codex-host-p', receiverThreadId: 'receiver-p',
  });
  await assert.rejects(
    h.taskExecution(engine, { action: 'bind',
      id: task.id, boardId: board.id, requestId: 'req-p2', runId: started.request.runId, claimId: 'claim-p',
      phase: 'created', threadId: 'native-thread-p', hostId: 'codex-host-p',
      workspacePath: '/tmp/somewhere', workspaceOwner: 'user',
    }),
    (err: Error) => /不记录工作区/.test(err.message),
  );
});

test('契约：board_create 接受非 Git 目录并返回非 Git 看板；board_list 返回项目目录与能力字段', async () => {
  const git = new StubGitService();
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'tl-nongit-mcp-')));
  const plainDir = path.join(base, 'plain');
  mkdirSync(plainDir);
  git.setDir(plainDir, null);
  const { engine } = makeEngine(git);

  const { board } = await h.boardCreate(engine, { repo: plainDir });
  assert.equal(board.projectDir, realpathSync(plainDir));
  assert.equal(board.repo, null);
  assert.equal(board.repoKey, null);

  const { boards } = await h.boardList(engine);
  const plain = boards.find((b) => b.id === board.id)!;
  assert.equal(plain.projectDir, realpathSync(plainDir));
  assert.equal(plain.repoKey, null);
  // default 无项目看板仍在列表中
  assert.ok(boards.some((b) => b.id === 'default' && !b.projectDir && !b.repo));
});

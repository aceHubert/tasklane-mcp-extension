import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execPath } from 'node:process';
import { BoardError, ModelCatalogService } from '../src/index.js';

/**
 * stub app-server：按行读取 JSON-RPC 请求，行为由 TASKLANE_STUB_MODE 控制，
 * 覆盖分页、通知行、RPC error、超时不响应、非 JSON 输出与提前退出。
 */
const STUB_SOURCE = `
import readline from 'node:readline';
const mode = process.env.TASKLANE_STUB_MODE ?? 'pages';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
// early-exit 模式：收到首个请求即同步退出、不响应，保证 initialize 必然失败
rl.on('line', () => { if (mode === 'early-exit') process.exit(1); });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    if (mode === 'notify-first') send({ jsonrpc: '2.0', method: 'agent/started', params: {} });
    if (mode === 'rpc-error') {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'stub catalog failure' } });
      return;
    }
    send({ jsonrpc: '2.0', id: req.id, result: { ok: true } });
    return;
  }
  if (req.method === 'model/list') {
    if (mode === 'timeout') return; // 永不响应，触发调用方超时
    if (mode === 'garbage') {
      process.stdout.write('this-line-is-not-json\\n');
      send({ jsonrpc: '2.0', id: req.id, result: { data: [{ id: 'm-g' }], nextCursor: null } });
      return;
    }
    if (mode === 'pages' && !req.params?.cursor) {
      send({
        jsonrpc: '2.0', id: req.id,
        result: {
          data: [
            { id: 'm-a', displayName: 'Model A', isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'low' }] },
            { slug: 'm-b', display_name: 'Model B', supported_reasoning_levels: [{ effort: 'max' }] },
          ],
          nextCursor: 'page-2',
        },
      });
      return;
    }
    send({ jsonrpc: '2.0', id: req.id, result: { data: [{ id: '', displayName: '无 ID 应被丢弃' }, { id: 'm-c' }], nextCursor: null } });
    return;
  }
});
`;

const stubDir = mkdtempSync(path.join(tmpdir(), 'tasklane-stub-app-server-'));
const stubPath = path.join(stubDir, 'stub-app-server.mjs');
writeFileSync(stubPath, STUB_SOURCE);
after(() => rmSync(stubDir, { recursive: true, force: true }));

function makeService(mode: string, timeoutMs?: number): ModelCatalogService {
  return new ModelCatalogService({
    launch: [execPath, stubPath],
    ...(timeoutMs ? { timeoutMs } : {}),
    env: { TASKLANE_STUB_MODE: mode },
  });
}

function assertCatalogError(err: unknown, pattern: RegExp) {
  assert.ok(err instanceof BoardError, `应为 BoardError，实际: ${String(err)}`);
  assert.equal(err.code, 'MODEL_CATALOG');
  assert.ok(pattern.test(err.message), `错误信息不符: ${err.message}`);
}

test('模型目录分页聚合并做宽松字段映射，丢弃无 ID 条目', async () => {
  const result = await makeService('pages').listModels();
  assert.deepEqual(result.models, [
    { id: 'm-a', displayName: 'Model A', isDefault: true, supportedReasoningEfforts: ['low', 'high'] },
    { id: 'm-b', displayName: 'Model B', supportedReasoningEfforts: ['max'] },
    { id: 'm-c' },
  ]);
  assert.equal(result.defaultModelId, 'm-a');
});

test('通知行与非 JSON 输出被忽略，不中断协议', async () => {
  for (const mode of ['notify-first', 'garbage']) {
    const result = await makeService(mode).listModels();
    assert.ok(result.models.length >= 1, `${mode} 应返回模型`);
  }
});

test('JSON-RPC error、超时、提前退出、命令缺失统一映射 MODEL_CATALOG', async () => {
  await assert.rejects(makeService('rpc-error').listModels(), (err: unknown) => {
    assertCatalogError(err, /stub catalog failure/);
    return true;
  });
  await assert.rejects(makeService('timeout', 400).listModels(), (err: unknown) => {
    assertCatalogError(err, /超时/);
    return true;
  });
  await assert.rejects(makeService('early-exit').listModels(), (err: unknown) => {
    assertCatalogError(err, /提前退出|不可用/);
    return true;
  });
  await assert.rejects(
    new ModelCatalogService({ launch: ['tasklane-missing-cmd-xyz'] }).listModels(),
    (err: unknown) => {
      assertCatalogError(err, /app-server/);
      return true;
    },
  );
});

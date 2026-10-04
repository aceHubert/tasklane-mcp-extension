import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  BoardEngine,
  BoardError,
  GitService,
  JsonFileBoardStore,
  ModelCatalogService,
  type ModelCatalogResult,
} from '@tasklane/core';
import { createServer } from '../src/server.js';

/** 目录服务替身：不经真实 app-server，验证工具契约与错误通道 */
class StubCatalog extends ModelCatalogService {
  constructor(private readonly behavior: 'ok' | 'fail') {
    super({ launch: ['stub-not-launched'] });
  }
  override async listModels(): Promise<ModelCatalogResult> {
    if (this.behavior === 'fail') throw new BoardError('MODEL_CATALOG', '目录暂不可用');
    return {
      models: [
        { id: 'm-a', displayName: 'Model A', isDefault: true, supportedReasoningEfforts: ['low', 'high'] },
        { id: 'm-b' },
      ],
      defaultModelId: 'm-a',
    };
  }
}

async function connect(behavior: 'ok' | 'fail') {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tl-model-catalog-')), 'board.json');
  const engine = new BoardEngine(new JsonFileBoardStore(file), new GitService(false));
  const server = createServer(engine, { catalog: new StubCatalog(behavior) });
  const client = new Client({ name: 'model-catalog-contract-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test('model_list 契约：无必填参数，成功透传目录，失败走 MODEL_CATALOG 错误通道', async (t) => {
  const okFixture = await connect('ok');
  t.after(async () => {
    await okFixture.client.close();
    await okFixture.server.close();
  });
  const { tools } = await okFixture.client.listTools();
  const tool = tools.find((candidate) => candidate.name === 'model_list');
  assert.ok(tool, 'model_list 应注册');
  assert.deepEqual(tool.inputSchema.required ?? [], []);

  const result = await okFixture.client.callTool({ name: 'model_list', arguments: {} });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse((result.content as { text: string }[])[0].text);
  assert.deepEqual(payload, {
    models: [
      { id: 'm-a', displayName: 'Model A', isDefault: true, supportedReasoningEfforts: ['low', 'high'] },
      { id: 'm-b' },
    ],
    defaultModelId: 'm-a',
  });
  assert.deepEqual(result.structuredContent, payload);

  const failFixture = await connect('fail');
  t.after(async () => {
    await failFixture.client.close();
    await failFixture.server.close();
  });
  const failure = await failFixture.client.callTool({ name: 'model_list', arguments: {} });
  assert.equal(failure.isError, true);
  assert.match((failure.content as { text: string }[])[0].text, /\[MODEL_CATALOG\] 目录暂不可用/);
});

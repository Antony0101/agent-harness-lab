import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MemoryService } from '../src/memory/service.js';
import { memoryAgentHandler } from '../src/memory/agent.js';
import { approvalBroker } from '../src/tools/approval-ipc.js';
import { temporary } from './helpers.js';

test('real MCP subprocess delegates memory search/read/save to the authenticated parent-owned service', async t => {
  const env = await temporary(); const service = await MemoryService.open(env.root, env.store.root);
  let allow = false; const proposals: unknown[] = [];
  const handler = memoryAgentHandler(service, async (_name, details) => { proposals.push(details); return allow; }, () => ({ sessionId: 'parent-session', turnId: 'parent-turn' }));
  const broker = await approvalBroker(async () => false, handler);
  const client = new Client({ name: 'memory-integration', version: '1' });
  let stderr = '';
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/tools/server.ts'), env.root], stderr: 'pipe',
    env: { HARNESS_APPROVAL_SOCKET: broker.path, HARNESS_APPROVAL_TOKEN: broker.token },
  });
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => { await client.close(); await broker.close(); await service.close(); await env.cleanup(); });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 11);
  assert.equal(tools.find(tool => tool.name === 'memory_save')?.annotations?.readOnlyHint, false);
  const args = { kind: 'facts', title: 'Pineapple', body: 'Pineapple is our synthetic test codename.' };
  const before = await readFile(service.databasePath);
  assert.equal((await client.callTool({ name: 'memory_save', arguments: args })).isError, true);
  assert.deepEqual(await readFile(service.databasePath), before);
  assert.equal(proposals.length, 1);
  allow = true;
  const saved = await client.callTool({ name: 'memory_save', arguments: args });
  assert.equal(saved.isError, undefined);
  const result = JSON.parse((saved.content as Array<{ text: string }>)[0].text) as { id: string; source: string };
  assert.match(await readFile(result.source, 'utf8'), /Pineapple/);
  assert.deepEqual((await service.read(result.id)).provenance, { sessionId: 'parent-session', turnId: 'parent-turn' });
  const hits = await client.callTool({ name: 'memory_search', arguments: { query: 'pineapple', limit: 1 } });
  assert.match(JSON.stringify(hits), /synthetic test codename/);
  const read = await client.callTool({ name: 'memory_read', arguments: { id: result.id } });
  assert.equal(JSON.parse((read.content as Array<{ text: string }>)[0].text).markdown, await readFile(result.source, 'utf8'));
  assert.equal((await client.callTool({ name: 'memory_read', arguments: { id: '../outside.md' } })).isError, true);
  assert.equal((await client.callTool({ name: 'memory_save', arguments: { ...args, provenance: { sessionId: 'forged' } } })).isError, true);
  const large = await service.add('lessons', 'Complete source', 'longword '.repeat(6000));
  const full = await client.callTool({ name: 'memory_read', arguments: { id: large.id } });
  assert.equal(JSON.parse((full.content as Array<{ text: string }>)[0].text).markdown, await readFile(large.source, 'utf8'));
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeFile(join(service.directory, 'facts', `batch-${i}.md`), `# Batch ${i}\n\n${'batchword '.repeat(70)}`)));
  const batch = await client.callTool({ name: 'memory_search', arguments: { query: 'batchword', limit: 20 } });
  const batchText = (batch.content as Array<{ text: string }>)[0].text;
  assert.ok(batchText.length > 12000); assert.equal(JSON.parse(batchText).length, 20);
  assert.doesNotMatch(stderr, /SQLite/); // Child imports only the adapter, never the database implementation.
});

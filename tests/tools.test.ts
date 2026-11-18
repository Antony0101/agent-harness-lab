import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { createJournalServer } from '../src/tools/server.js';
import { journalRegistry } from '../src/tools/journal.js';
import { approvalBroker, requestToolApproval } from '../src/tools/approval-ipc.js';
import { toyLoop, toyRegistry, scriptedModel } from '../examples/toy-loop.js';
import { temporary } from './helpers.js';

test('toy loop handles success, unknown tools, invalid arguments, denials, failures, and iteration cap', async () => {
  const success = await toyLoop(scriptedModel('success'), toyRegistry(), 'task', () => {});
  assert.match(success.answer, /Empty arrays sum to zero/); assert.equal(success.observations.length, 1);
  for (const mode of ['unknown', 'invalid', 'denied', 'error']) {
    const result = await toyLoop(scriptedModel(mode), toyRegistry(), 'task', () => {});
    assert.equal(result.observations[0].error, true, mode);
  }
  const limit = await toyLoop(scriptedModel('limit'), toyRegistry(), 'task', () => {});
  assert.equal(limit.status, 'limit'); assert.equal(limit.observations.length, 5);
});
test('journal validates input, bounds output, and performs no denied write', async t => {
  const env = await temporary(); t.after(env.cleanup);
  const path = join(env.root, 'notes', 'learning-journal.md'); const before = await readFile(path, 'utf8');
  const denied = journalRegistry(env.root);
  assert.equal((await denied.call('missing', {})).isError, true);
  assert.equal((await denied.call('journal_read', { limit: 100000 })).isError, true);
  assert.equal((await denied.call('journal_read', { path: '/etc/passwd' })).isError, true);
  assert.equal((await denied.call('journal_append', { entry: 'Must not be saved' })).isError, true);
  assert.equal(await readFile(path, 'utf8'), before);
  const found = await denied.call('journal_search', { query: 'paper' }); assert.match(found.content[0].text, /Paper Kite/);
  const allowed = journalRegistry(env.root, async () => true);
  assert.equal((await allowed.call('journal_append', { entry: 'Approved learning' })).isError, undefined);
  assert.match(await readFile(path, 'utf8'), /Approved learning/);
  assert.equal((await allowed.call('journal_read', { limit: 4 })).content[0].text.includes('"truncated":true'), true);
});
test('journal refuses a symlink to a different file and reports missing content', async t => {
  const env = await temporary(); t.after(env.cleanup);
  const path = join(env.root, 'notes', 'learning-journal.md'); const outside = join(env.root, 'outside');
  await writeFile(outside, 'private'); await unlink(path); await symlink(outside, path);
  const registry = journalRegistry(env.root, async () => true);
  assert.equal((await registry.call('journal_read', {})).isError, true);
  assert.equal((await registry.call('journal_append', { entry: 'bad' })).isError, true);
  assert.equal(await readFile(outside, 'utf8'), 'private');
  await unlink(path); assert.equal((await registry.call('journal_read', {})).isError, true);
});
test('MCP integration discovers tools and calls the actual journal handler', async t => {
  const env = await temporary(); t.after(env.cleanup);
  const server = createJournalServer(env.root); const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const tools = await client.listTools(); assert.equal(tools.tools.length, 3);
    const result = await client.callTool({ name: 'journal_search', arguments: { query: 'Paper Kite' } });
    assert.match(JSON.stringify(result), /Paper Kite/);
  } finally { await client.close(); await server.close(); }
});
test('private IPC waits for application decision and fails closed without a bridge', async () => {
  const previousPath = process.env.HARNESS_APPROVAL_SOCKET; const previousToken = process.env.HARNESS_APPROVAL_TOKEN;
  const broker = await approvalBroker(async (name, args) => name === 'journal_append' && (args as { entry: string }).entry === 'ok');
  try {
    process.env.HARNESS_APPROVAL_SOCKET = broker.path; process.env.HARNESS_APPROVAL_TOKEN = broker.token;
    assert.equal(await requestToolApproval('journal_append', { entry: 'ok' }), true);
    assert.equal(await requestToolApproval('journal_append', { entry: 'no' }), false);
    process.env.HARNESS_APPROVAL_TOKEN = 'wrong'; assert.equal(await requestToolApproval('journal_append', { entry: 'ok' }), false);
    delete process.env.HARNESS_APPROVAL_TOKEN; assert.equal(await requestToolApproval('journal_append', { entry: 'ok' }), false);
  } finally {
    if (previousPath === undefined) delete process.env.HARNESS_APPROVAL_SOCKET; else process.env.HARNESS_APPROVAL_SOCKET = previousPath;
    if (previousToken === undefined) delete process.env.HARNESS_APPROVAL_TOKEN; else process.env.HARNESS_APPROVAL_TOKEN = previousToken;
    await broker.close();
  }
});

test('MCP stdio subprocess returns clean protocol output and denies writes without IPC', async t => {
  const env = await temporary(); t.after(env.cleanup);
  const client = new Client({ name: 'stdio-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/tools/server.ts'), env.root], stderr: 'pipe', env: {} });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 3);
    const result = await client.callTool({ name: 'journal_search', arguments: { query: 'Paper Kite' } });
    assert.match(JSON.stringify(result), /Paper Kite/);
    const denied = await client.callTool({ name: 'journal_append', arguments: { entry: 'No approval bridge' } });
    assert.equal(denied.isError, true);
  } finally { await client.close(); }
});

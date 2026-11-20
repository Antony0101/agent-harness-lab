import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WorkspaceTools } from '../src/workspace-tools/service.js';
import { approvalBroker } from '../src/tools/approval-ipc.js';
import { temporary, waitFor } from './helpers.js';

const execute = promisify(execFile);
test('MCP discovers eleven tools and forwards all five workspace operations to the authenticated parent', async t => {
  const env = await temporary(); const service = await WorkspaceTools.open(env.root, env.store.root);
  await writeFile(join(env.root, 'visible.txt'), 'Plum learning example');
  await writeFile(join(env.root, 'package.json'), JSON.stringify({ scripts: { typecheck: `${JSON.stringify(process.execPath)} -e "console.log('CHECK-PASSED')"` } }));
  await execute('git', ['init', '-q'], { cwd: env.root });
  let allow = false; let waitApproval = false; let waiting = false; let cancelled = false;
  const proposals: unknown[] = [];
  const broker = await approvalBroker(async () => false, undefined, (name, args, signal) => service.call(name, args, {
    origin: 'agent', writable: true, signal,
    confirm: async (_name, details, operationSignal) => {
      proposals.push(details);
      if (!waitApproval) return allow;
      waiting = true;
      return new Promise<boolean>(resolveDecision => operationSignal!.addEventListener('abort', () => { cancelled = true; resolveDecision(false); }, { once: true }));
    },
  }));
  const client = new Client({ name: 'workspace-integration', version: '1' });
  // Deliberately give the MCP child a different journal root. Workspace
  // operations must use the parent-selected workspace, never the child's argv.
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/tools/server.ts'), join(env.root, 'wrong-child-root')], stderr: 'pipe',
    env: { ...process.env as Record<string, string>, HARNESS_APPROVAL_SOCKET: broker.path, HARNESS_APPROVAL_TOKEN: broker.token },
  });
  t.after(async () => { await client.close(); await broker.close(); await service.close(); await env.cleanup(); });
  await client.connect(transport);
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 11);
  assert.equal(tools.find(tool => tool.name === 'project_check')?.annotations?.readOnlyHint, false);
  assert.equal(tools.find(tool => tool.name === 'workspace_search')?.annotations?.readOnlyHint, true);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, data: JSON.parse((result.content as Array<{ text: string }>)[0].text) };
  };
  assert.equal((await call('workspace_search', { query: 'plum' })).data.matches[0].path, 'visible.txt');
  assert.ok((await call('git_inspect', { operation: 'status' })).data.entries.some((entry: { path: string }) => entry.path === 'visible.txt'));
  assert.ok((await call('project_check')).data.scripts.typecheck);
  assert.equal((await call('todo_list')).data.revision, 0);
  const batch = { revision: 0, changes: [{ operation: 'add', title: 'Learn parent execution' }] };
  assert.equal((await call('todo_update', batch)).result.isError, true);
  assert.equal((await call('project_check', { script: 'typecheck' })).result.isError, true);
  await assert.rejects(stat(service.todos.path), { code: 'ENOENT' });
  allow = true;
  assert.equal((await call('todo_update', batch)).data.tasks[0].title, 'Learn parent execution');
  const check = await call('project_check', { script: 'typecheck' }); assert.equal(check.data.passed, true); assert.match(check.data.output, /CHECK-PASSED/);
  assert.ok(proposals.some(value => JSON.stringify(value).includes('executable')));
  assert.equal((await call('todo_update', { ...batch, origin: 'user' })).result.isError, true);
  assert.equal((await call('workspace_search', { query: 'plum', workspace: '/etc' })).result.isError, true);
  assert.equal((await call('unregistered_tool')).result.isError, true);
  const before = await readFile(service.todos.path, 'utf8');
  waitApproval = true; const controller = new AbortController();
  const pending = client.callTool({ name: 'todo_update', arguments: { revision: 1, changes: [{ operation: 'add', title: 'Cancelled proposal' }] } }, undefined, { signal: controller.signal });
  void pending.catch(() => {}); await waitFor(() => waiting); controller.abort();
  await assert.rejects(pending); await waitFor(() => cancelled);
  assert.equal(await readFile(service.todos.path, 'utf8'), before);
});

test('private socket rejects invalid credentials and unknown operations before dispatch', async () => {
  let calls = 0;
  const broker = await approvalBroker(async () => false, undefined, async () => { calls++; return {}; });
  const send = (frame: unknown) => new Promise<{ error: string }>((resolveResult, reject) => {
    const socket = createConnection(broker.path); let buffer = '';
    socket.on('connect', () => socket.write(JSON.stringify(frame) + '\n')); socket.setEncoding('utf8');
    socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { resolveResult(JSON.parse(buffer.split('\n')[0])); socket.destroy(); } });
    socket.on('error', reject);
  });
  try {
    assert.match((await send({ token: 'wrong', name: 'todo_list', args: {} })).error, /credential/);
    assert.match((await send({ token: broker.token, name: 'arbitrary_exec', args: {} })).error, /Unsupported/);
    assert.equal(calls, 0);
  } finally { await broker.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexClient, type CodexOptions, type Turn } from '../src/codex.js';
import { Session } from '../src/session.js';
import { Approvals } from '../src/approvals.js';
import { EventRenderer } from '../src/events.js';
import { Rpc } from '../src/rpc.js';
import { MemoryTransport, temporary, tick, waitFor } from './helpers.js';
import type { WireMessage } from '../src/transport.js';
import { MemoryService } from '../src/memory/service.js';
import { memoryAgentHandler } from '../src/memory/agent.js';
import { deferred } from '../src/util.js';
import type { MemoryRecall } from '../src/memory/types.js';
import { WorkspaceTools } from '../src/workspace-tools/service.js';

function terminal(id = 't', status: Turn['status'] = 'completed'): Turn {
  return { id, status, items: [], error: null, rootTurnId: null, itemsView: 'full', startedAt: null, completedAt: null, durationMs: null };
}
async function setup(interactive = false, useMemory = false, writable = true) {
  const env = await temporary(); const transport = new MemoryTransport(); const rpc = new Rpc(transport);
  const options: CodexOptions = { bin: 'fake', workspace: env.root, root: env.root, writable };
  const client = new CodexClient(rpc, options); const approvals = new Approvals(interactive, () => {});
  const memories = useMemory ? await MemoryService.open(env.root, env.store.root) : undefined;
  let output = '';
  const session = new Session(client, env.store, approvals, new EventRenderer(() => {}), text => { output += text; }, 'fake-v1', 5000, memories);
  session.memory = useMemory;
  transport.handler = value => {
    if (value.method === 'thread/start' || value.method === 'thread/resume') {
      transport.receive({ id: value.id, result: { thread: { id: 'thread', cwd: env.root, status: { type: 'idle' } } } });
    }
  };
  await session.fresh();
  return { ...env, transport, rpc, session, approvals, client, memories, output: () => output,
    cleanup: async () => { approvals.close(); await rpc.close(); await env.store.flush(); await memories?.close(); await env.cleanup(); } };
}

test('turn completion arriving before acknowledgment is not lost', async t => {
  const env = await setup(); t.after(env.cleanup);
  env.transport.handler = value => {
    if (value.method !== 'turn/start') return;
    env.transport.receive({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 't' } } });
    env.transport.receive({ method: 'item/completed', params: { threadId: 'thread', turnId: 't', item: { id: 'm', type: 'agentMessage', text: 'Done' } } });
    env.transport.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: terminal() } });
    env.transport.receive({ id: value.id, result: { turn: terminal('t', 'inProgress') } });
  };
  const result = await env.session.run('task');
  assert.equal(result.status, 'completed'); assert.equal(result.text, 'Done'); assert.equal(env.session.busy, false);
});
test('active turn rejects concurrent work and disconnect makes outcome unknown', async t => {
  const env = await setup(); t.after(env.cleanup);
  env.transport.handler = value => {
    if (value.method === 'turn/start') env.transport.receive({ id: value.id, result: { turn: terminal('t', 'inProgress') } });
  };
  const result = env.session.run('task'); void result.catch(() => {}); await tick(); await tick();
  await assert.rejects(env.session.run('another'), /already active/);
  env.transport.emit('disconnect', new Error('lost connection'));
  await assert.rejects(result, /lost connection/); assert.equal(env.session.status, 'unknown');
  await assert.rejects(env.session.run('retry'), /explicitly resume/);
});
test('runtime approval uses original ID and supported rejection in noninteractive mode', async t => {
  const env = await setup(); t.after(env.cleanup);
  let submitted = false;
  env.transport.handler = value => {
    if (value.method === 'turn/start') {
      submitted = true;
      env.transport.receive({ id: value.id, result: { turn: terminal('t', 'inProgress') } });
      env.transport.receive({ id: 'approval-zero', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 't', command: 'effectful' } });
    } else if (value.id === 'approval-zero') {
      assert.deepEqual(value.result, { decision: 'decline' });
      env.transport.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: terminal() } });
    }
  };
  await env.session.run('task'); assert.equal(submitted, true);
});
test('resolved runtime approvals cannot later accept work', async t => {
  const env = await setup(true); t.after(env.cleanup);
  env.transport.handler = value => {
    if (value.method === 'turn/start') env.transport.receive({ id: value.id, result: { turn: terminal('t', 'inProgress') } });
  };
  const run = env.session.run('task'); await tick(); await tick();
  env.transport.receive({ id: 0, method: 'item/fileChange/requestApproval', params: { threadId: 'thread', turnId: 't', reason: 'write' } });
  assert.ok(env.approvals.active);
  env.transport.receive({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 0 } });
  assert.equal(env.approvals.answer('runtime:number:0', '2'), false);
  await tick();
  assert.equal(env.transport.sent.some(value => value.id === 0 && 'result' in value), false);
  env.transport.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: terminal() } }); await run;
});
test('unsupported server requests receive protocol errors rather than hanging', async t => {
  const env = await setup(); t.after(env.cleanup);
  env.transport.receive({ id: 'unknown', method: 'new/server/request', params: {} }); await tick();
  const response = env.transport.sent.find(value => value.id === 'unknown'); assert.equal(response?.error?.code, -32601);
});
test('resume uses runtime history and refuses a runtime that is still active', async t => {
  const env = await setup(); t.after(env.cleanup); const id = env.session.record!.id;
  await env.session.resume(id);
  assert.equal(env.transport.sent.at(-1)?.method, 'thread/resume');
  const handler = env.transport.handler;
  env.transport.handler = (value: WireMessage) => {
    if (value.method === 'thread/resume') env.transport.receive({ id: value.id, result: { thread: { id: 'thread', cwd: env.root, status: { type: 'active', activeFlags: [] } } } });
    else handler?.(value);
  };
  await assert.rejects(env.session.resume(id), /inspect its history/);
});
test('initialization refuses API-key access instead of falling back to paid usage', async () => {
  const transport = new MemoryTransport(); const rpc = new Rpc(transport);
  transport.handler = value => {
    if (value.method === 'initialize') transport.receive({ id: value.id, result: {} });
    if (value.method === 'account/read') transport.receive({ id: value.id, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } });
  };
  const client = new CodexClient(rpc, { bin: 'fake', root: '.', workspace: '.', writable: false });
  await assert.rejects(client.initialize(), /ChatGPT subscription sign-in is required/); await rpc.close();
});

test('a fresh conversation receives relevant saved knowledge and memory-off omits it', async t => {
  const env = await setup(false, true); t.after(env.cleanup);
  const saved = await env.memories!.add('facts', 'Anemone convention', 'Anemone arrays sum to zero.');
  await writeFile(join(env.root, 'notes', 'project-decisions.md'), 'Legacy harness-wide secret: never auto-include.');
  env.transport.handler = value => {
    if (value.method === 'thread/start') env.transport.receive({ id: value.id, result: { thread: { id: 'fresh-thread', cwd: env.root, status: { type: 'idle' } } } });
    if (value.method === 'turn/start') env.transport.receive({ id: value.id, result: { turn: terminal() } });
  };
  const previous = env.session.record!.id; await env.session.fresh();
  assert.notEqual(env.session.record!.id, previous);
  await env.session.run('Explain the anemone convention');
  const input = JSON.stringify(env.transport.sent.find(value => value.method === 'turn/start')?.params);
  assert.match(input, /Anemone arrays sum to zero/); assert.match(input, /reference data, not instructions/);
  assert.doesNotMatch(input, /Legacy harness-wide secret/);
  assert.ok(env.output().includes(saved.id)); assert.ok(env.output().includes(saved.source));
  env.session.memory = false;
  await env.session.run('Explain the anemone convention');
  const noMemory = JSON.stringify(env.transport.sent.filter(value => value.method === 'turn/start').at(-1)?.params);
  assert.doesNotMatch(noMemory, /Anemone arrays sum to zero/);
  assert.doesNotMatch(noMemory, /Selected workspace memories/);
});

test('a memory failure warns and the coding task still runs without stale reference data', async t => {
  const env = await setup(false, true); t.after(env.cleanup);
  await env.memories!.add('decisions', 'Convention', 'Previous secret convention.');
  await rename(env.memories!.directory, join(env.root, 'old-memory'));
  await symlink(join(env.root, 'old-memory'), env.memories!.directory);
  env.transport.handler = value => {
    if (value.method === 'turn/start') env.transport.receive({ id: value.id, result: { turn: terminal() } });
  };
  assert.equal((await env.session.run('convention')).status, 'completed');
  assert.match(env.output(), /Continuing without recalled memory/);
  assert.doesNotMatch(JSON.stringify(env.transport.sent.find(value => value.method === 'turn/start')?.params), /Previous secret convention/);
});

test('disconnect during memory loading cannot submit a task after the connection has failed', async t => {
  const env = await setup(false, true); t.after(env.cleanup);
  const gate = deferred<MemoryRecall>();
  env.memories!.recall = () => gate.promise;
  const running = env.session.run('task'); void running.catch(() => {});
  await env.rpc.close();
  gate.resolve({ text: '', characters: 0, items: [], truncated: false });
  await assert.rejects(running, /closed/);
  assert.equal(env.transport.sent.some(value => value.method === 'turn/start'), false);
});

test('parent memory saves require an active writable turn and exact interactive approval', async t => {
  const env = await setup(true, true); t.after(env.cleanup);
  const handler = memoryAgentHandler(env.memories!, (name, details, signal) => env.session.toolApproval(name, details, signal),
    () => ({ sessionId: env.session.record!.id, turnId: env.session.turnId }));
  const args = { kind: 'lessons', title: 'Learning', body: 'Complete proposed content for inspection.' };
  await assert.rejects(handler('memory_save', args), /denied/);
  env.transport.handler = value => {
    if (value.method === 'turn/start') env.transport.receive({ id: value.id, result: { turn: terminal('t', 'inProgress') } });
  };
  const running = env.session.run('learn'); await waitFor(() => !!env.session.turnId);
  const before = await readFile(env.memories!.databasePath);
  const denied = handler('memory_save', args);
  await waitFor(() => !!env.approvals.active);
  assert.deepEqual(env.approvals.active?.details, { ...args, destination: (env.approvals.active?.details as { destination: string }).destination });
  assert.match((env.approvals.active?.details as { destination: string }).destination, /memory\/lessons\//);
  assert.equal(env.approvals.answer('wrong-id', '2'), false);
  env.approvals.answer(env.approvals.active!.id, '1');
  await assert.rejects(denied, /denied/);
  assert.deepEqual(await readFile(env.memories!.databasePath), before);
  assert.deepEqual(await env.memories!.list(), []);
  const approved = handler('memory_save', args); await waitFor(() => !!env.approvals.active);
  env.approvals.answer(env.approvals.active!.id, '2');
  const result = await approved as { id: string };
  assert.deepEqual((await env.memories!.read(result.id)).provenance, { sessionId: env.session.record!.id, turnId: 't' });
  const controller = new AbortController();
  const aborted = handler('memory_save', args, controller.signal); await waitFor(() => !!env.approvals.active);
  controller.abort(); await assert.rejects(aborted, /denied|abort/i); assert.equal(env.approvals.active, undefined);
  const ended = handler('memory_save', args); await waitFor(() => !!env.approvals.active);
  env.transport.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: terminal() } });
  await assert.rejects(ended, /denied/); await running;
  assert.equal((await env.memories!.list()).length, 1);
});

test('read-only and noninteractive sessions deny agent memory saves', async t => {
  for (const [interactive, writable] of [[true, false], [false, true]]) {
    const env = await setup(interactive, true, writable); t.after(env.cleanup);
    env.transport.handler = value => {
      if (value.method === 'turn/start') env.transport.receive({ id: value.id, result: { turn: terminal('t', 'inProgress') } });
    };
    const running = env.session.run('learn'); await waitFor(() => !!env.session.turnId);
    const handler = memoryAgentHandler(env.memories!, (name, details, signal) => env.session.toolApproval(name, details, signal), () => ({}));
    await assert.rejects(handler('memory_save', { kind: 'facts', title: 'Denied', body: 'body' }), /denied/);
    assert.equal(env.approvals.active, undefined); assert.deepEqual(await env.memories!.list(), []);
    env.transport.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: terminal() } }); await running;
  }
});

test('workspace task approvals are tied to the active turn and cannot survive completion', async t => {
  const env = await setup(true); const tools = await WorkspaceTools.open(env.root, env.store.root);
  t.after(async () => { await tools.close(); await env.cleanup(); });
  env.transport.handler = value => {
    if (value.method === 'turn/start') env.transport.receive({ id: value.id, result: { turn: terminal('t', 'inProgress') } });
  };
  const call = () => tools.call('todo_update', { revision: 0, changes: [{ operation: 'add', title: 'Turn-scoped task' }] }, {
    origin: 'agent', writable: true, signal: env.session.toolSignal,
    confirm: (name, details, signal) => env.session.toolApproval(name, details, signal),
  });
  await assert.rejects(call(), /denied/);
  const running = env.session.run('track tasks'); await waitFor(() => !!env.session.turnId);
  const pending = call(); void pending.catch(() => {}); await waitFor(() => !!env.approvals.active);
  assert.equal(env.approvals.active!.options[1].label, 'Apply task changes');
  const turnSignal = env.session.toolSignal;
  env.transport.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: terminal() } });
  await running; await assert.rejects(pending, /denied|abort|cancel/i);
  assert.equal(turnSignal?.aborted, true);
  assert.deepEqual((await tools.call('todo_list', {}, { origin: 'user', writable: false, confirm: async () => true }) as { tasks: unknown[] }).tasks, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexClient, type CodexOptions, type Turn } from '../src/codex.js';
import { Session } from '../src/session.js';
import { Approvals } from '../src/approvals.js';
import { EventRenderer } from '../src/events.js';
import { Rpc } from '../src/rpc.js';
import { MemoryTransport, temporary, tick } from './helpers.js';
import type { WireMessage } from '../src/transport.js';

function terminal(id = 't', status: Turn['status'] = 'completed'): Turn {
  return { id, status, items: [], error: null, rootTurnId: null, itemsView: 'full', startedAt: null, completedAt: null, durationMs: null };
}
async function setup(interactive = false) {
  const env = await temporary(); const transport = new MemoryTransport(); const rpc = new Rpc(transport);
  const options: CodexOptions = { bin: 'fake', workspace: env.root, root: env.root, writable: true };
  const client = new CodexClient(rpc, options); const approvals = new Approvals(interactive, () => {});
  const session = new Session(client, env.store, approvals, new EventRenderer(() => {}), () => {}, 'fake-v1', 5000);
  session.memory = false;
  transport.handler = value => {
    if (value.method === 'thread/start' || value.method === 'thread/resume') {
      transport.receive({ id: value.id, result: { thread: { id: 'thread', cwd: env.root, status: { type: 'idle' } } } });
    }
  };
  await session.fresh();
  return { ...env, transport, rpc, session, approvals, client, cleanup: async () => { approvals.close(); await rpc.close(); await env.store.flush(); await env.cleanup(); } };
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

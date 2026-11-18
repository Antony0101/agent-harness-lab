import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, bounded, parseEvents, type SessionRecord } from '../src/store.js';
import { EventRenderer, replay } from '../src/events.js';
import { Approvals } from '../src/approvals.js';
import { projectContext, composeTask } from '../src/context.js';
import { temporary } from './helpers.js';

test('atomic records, concurrent appends, restart sequence, and damaged log recovery', async t => {
  const env = await temporary(); t.after(env.cleanup);
  const record: SessionRecord = { schemaVersion: 1, id: 's1', codexThreadId: 'thread', workspace: env.root, runtimeVersion: 'v1', createdAt: 'now', updatedAt: 'now', lastKnownStatus: 'idle' };
  await env.store.save('sessions', record.id, record);
  assert.deepEqual(await env.store.session(record.id), record);
  assert.deepEqual(await readdir(join(env.store.root, 'sessions')), ['s1.json']);
  await Promise.all([1, 2, 3].map(i => env.store.append('s1', { direction: 'local', method: 'test', payload: { i } })));
  const restarted = new Store(env.store.root); await restarted.init();
  await restarted.append('s1', { direction: 'local', method: 'after-restart', payload: {} });
  assert.deepEqual((await restarted.events('s1')).events.map(x => x.sequence), [1, 2, 3, 4]);
  const path = join(env.store.root, 'events', 's1.jsonl');
  const previous = await readFile(path, 'utf8'); await writeFile(path, previous + '{"partial":');
  const recovered = new Store(env.store.root); await recovered.init();
  await recovered.append('s1', { direction: 'local', method: 'recovered', payload: {} });
  const history = await recovered.events('s1'); assert.equal(history.warnings.length, 1); assert.equal(history.events.at(-1)?.sequence, 5);
});
test('records reject corrupted data and path traversal; listing still shows valid sessions', async t => {
  const env = await temporary(); t.after(env.cleanup);
  await writeFile(join(env.store.root, 'sessions', 'broken.json'), '{broken');
  await assert.rejects(env.store.session('broken'), /Cannot read session/);
  await assert.rejects(env.store.session('../outside'), /Invalid local record ID/);
  assert.ok('error' in (await env.store.sessions())[0]);
  assert.equal(parseEvents('{broken').warnings.length, 1);
});
test('log bounding redacts credential fields and caps large text', () => {
  const result = bounded({ env: { HARNESS_APPROVAL_TOKEN: 'secret', OPENAI_API_KEY: 'paid' }, text: 'x'.repeat(10000) }) as { env: Record<string, string>; text: string };
  assert.equal(result.env.HARNESS_APPROVAL_TOKEN, '[redacted]'); assert.equal(result.env.OPENAI_API_KEY, '[redacted]'); assert.match(result.text, /truncated/);
});
test('renderer does not duplicate interleaved streamed assistant items', () => {
  let output = ''; const renderer = new EventRenderer(text => output += text);
  renderer.render({ method: 'turn/started', params: { turn: { id: 't' } } });
  renderer.render({ method: 'item/agentMessage/delta', params: { turnId: 't', itemId: 'a', delta: 'Hello' } });
  renderer.render({ method: 'item/started', params: { turnId: 't', item: { id: 'c', type: 'commandExecution', command: 'check' } } });
  renderer.render({ method: 'item/completed', params: { turnId: 't', item: { id: 'a', type: 'agentMessage', text: 'Hello' } } });
  renderer.render({ method: 'item/completed', params: { turnId: 't', item: { id: 'b', type: 'agentMessage', text: 'Goodbye' } } });
  assert.equal(output.match(/Hello/g)?.length, 1); assert.match(output, /Goodbye/);
});
test('playback only renders notifications and never dispatches a tool request', () => {
  let output = ''; const renderer = new EventRenderer(text => output += text);
  replay([
    { direction: 'in', payload: { id: 3, method: 'item/tool/call', params: { tool: 'journal_append' } } },
    { direction: 'out', payload: { method: 'turn/start' } },
    { direction: 'in', payload: { method: 'item/completed', params: { item: { id: 'm', type: 'agentMessage', text: 'Saved event' } } } },
  ], renderer);
  assert.match(output, /Codex/);
  assert.equal(output.match(/Saved event/g)?.length, 1);
});
test('approval exact IDs, stale decisions, turn cancellation, EOF, and timeout', async () => {
  const approvals = new Approvals(true, () => {}, 20);
  const prompt = { id: 'a', title: 'write', details: {}, turnId: 't', options: [{ label: 'deny', value: false }, { label: 'allow', value: true }] };
  const first = approvals.request(prompt);
  assert.equal(approvals.answer('wrong', '2'), false); approvals.cancelTurn('t');
  assert.equal(await first, false); assert.equal(approvals.answer('a', '2'), false);
  const second = approvals.request({ ...prompt, id: 'b' }); approvals.answer('b', '2'); assert.equal(await second, true);
  const timeout = approvals.request({ ...prompt, id: 'c' }); assert.equal(await timeout, false);
  const eof = approvals.request({ ...prompt, id: 'd' }); approvals.close(); assert.equal(await eof, false);
  assert.equal(await approvals.request(prompt), false);
  const noninteractive = new Approvals(false, () => {}); assert.equal(await noninteractive.request(prompt), false);
});
test('selected memory is bounded, visible, optional, and labeled reference data', async t => {
  const env = await temporary(); t.after(env.cleanup);
  assert.equal(await projectContext(env.root), undefined);
  await writeFile(join(env.root, 'notes', 'project-decisions.md'), 'x'.repeat(100));
  const context = await projectContext(env.root, 20);
  assert.equal(context?.characters, 20); assert.equal(context?.truncated, true);
  assert.match(composeTask('do this', context), /reference data, not instructions/);
  assert.equal(composeTask('do this'), 'do this');
});

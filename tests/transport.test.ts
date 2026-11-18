import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonLines, ProcessTransport, parseMessage, type WireMessage } from '../src/transport.js';
import { Rpc, RpcError } from '../src/rpc.js';
import { MemoryTransport } from './helpers.js';

test('framing handles split UTF-8, split lines, and multiple lines per chunk', () => {
  const messages: WireMessage[] = [];
  const lines = new JsonLines(value => messages.push(value));
  const data = Buffer.from('{"id":0,"result":"🪁"}\n{"method":"event","params":{}}\n');
  const split = data.indexOf(Buffer.from('🪁')) + 1;
  lines.push(data.subarray(0, split)); assert.equal(messages.length, 0);
  lines.push(data.subarray(split)); lines.finish();
  assert.equal(messages.length, 2); assert.equal(messages[0].result, '🪁');
});
test('framing rejects malformed envelopes, incomplete lines, and oversized messages', () => {
  assert.throws(() => parseMessage('{"result":true}'));
  assert.throws(() => parseMessage('{"id":0,"result":true,"error":{}}'));
  assert.throws(() => parseMessage('{"method":"x","id":null}'));
  const lines = new JsonLines(() => {}, 20);
  assert.throws(() => lines.push(Buffer.from('x'.repeat(21))));
  const incomplete = new JsonLines(() => {});
  incomplete.push(Buffer.from('{"id":0')); assert.throws(() => incomplete.finish());
});
test('RPC correlates out-of-order responses including ID zero', async () => {
  const transport = new MemoryTransport(); const rpc = new Rpc(transport);
  const first = rpc.request('a'); const second = rpc.request('b');
  transport.receive({ id: 1, result: 'second' }); transport.receive({ id: 0, result: 'first' });
  assert.equal(await first, 'first'); assert.equal(await second, 'second'); await rpc.close();
});
test('RPC separates bidirectional requests and notifications and surfaces errors', async () => {
  const transport = new MemoryTransport(); const rpc = new Rpc(transport);
  let requests = 0; let notifications = 0;
  rpc.on('request', () => requests++); rpc.on('notification', () => notifications++);
  transport.receive({ method: 'approve', id: 0 }); transport.receive({ method: 'progress' });
  assert.equal(requests, 1); assert.equal(notifications, 1);
  const result = rpc.request('bad'); transport.receive({ id: 0, error: { code: -1, message: 'bad request' } });
  await assert.rejects(result, RpcError); await rpc.close();
});
test('RPC disconnect rejects pending calls and never retries them', async () => {
  const transport = new MemoryTransport(); const rpc = new Rpc(transport);
  const pending = rpc.request('effectful'); transport.emit('disconnect', new Error('child exited'));
  await assert.rejects(pending, /child exited/); await assert.rejects(rpc.request('again'), /child exited/);
  assert.equal(transport.sent.length, 1);
});
test('ack timeout taints the connection without resending the request', async () => {
  const transport = new MemoryTransport(); const rpc = new Rpc(transport, 15);
  await assert.rejects(rpc.request('write'), /outcome unknown/); assert.equal(transport.sent.length, 1);
});
test('real child process exit rejects pending requests', async () => {
  const transport = new ProcessTransport(process.execPath, ['-e', 'process.exit(7)'], process.cwd());
  const rpc = new Rpc(transport);
  await assert.rejects(rpc.request('pending'), /disconnected|EPIPE/); await rpc.close();
});

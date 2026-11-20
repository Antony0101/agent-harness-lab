import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transport, WireMessage } from '../src/transport.js';
import { Store } from '../src/store.js';

export class MemoryTransport extends EventEmitter implements Transport {
  sent: WireMessage[] = [];
  handler?: (message: WireMessage) => void;
  send(value: WireMessage) { this.sent.push(value); this.handler?.(value); }
  receive(value: WireMessage) { this.emit('message', value); }
  async close() { this.emit('disconnect', new Error('closed')); }
}
export async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'harness-test-'));
  await mkdir(join(root, 'notes'));
  await writeFile(join(root, 'notes', 'learning-journal.md'), '# Journal\nSeed: Paper Kite\n');
  const store = new Store(join(root, '.harness')); await store.init();
  return { root, store, cleanup: () => rm(root, { recursive: true, force: true }) };
}
export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
export async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for test condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

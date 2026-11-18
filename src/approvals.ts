import { EventEmitter } from 'node:events';
import { deferred } from './util.js';
import type { TerminalUI } from './terminal.js';

export type ApprovalOption = { label: string; value: unknown };
export type ApprovalPrompt = {
  id: string; title: string; details: unknown; options: ApprovalOption[];
  threadId?: string; turnId?: string;
};

export class Approvals extends EventEmitter {
  private queue: Array<{ prompt: ApprovalPrompt; done: ReturnType<typeof deferred<unknown>>; timer: NodeJS.Timeout }> = [];
  private closed = false;
  constructor(private interactive: boolean, private write: (text: string) => void, private timeoutMs = 120_000, private ui?: TerminalUI) { super(); }
  get active(): ApprovalPrompt | undefined { return this.queue[0]?.prompt; }
  request(prompt: ApprovalPrompt): Promise<unknown> {
    // First option is always the supported deny/cancel response.
    if (this.closed || !this.interactive) return Promise.resolve(prompt.options[0].value);
    const done = deferred<unknown>();
    const timer = setTimeout(() => this.cancel(prompt.id), this.timeoutMs);
    this.queue.push({ prompt, done, timer });
    if (this.queue.length === 1) this.show();
    this.emit('change', true);
    return done.promise;
  }
  private show() {
    const p = this.active;
    if (!p) return;
    if (this.ui) { this.ui.approval(p); return; }
    this.write(`\n[approval ${p.id}] ${p.title}\n${JSON.stringify(p.details, null, 2)}\n`);
    this.write(p.options.map((option, i) => `${i + 1}. ${option.label}`).join('\n') + '\nUse /approve <request-id> <number>. Empty input denies.\n');
  }
  answer(id: string, choice: string): boolean {
    const item = this.queue[0];
    if (!item || item.prompt.id !== id) return false;
    const index = choice.trim() === '' ? 0 : Number(choice) - 1;
    if (!Number.isInteger(index) || !item.prompt.options[index]) return false;
    this.settle(0, item.prompt.options[index].value);
    return true;
  }
  private settle(index: number, value: unknown) {
    const [item] = this.queue.splice(index, 1);
    clearTimeout(item.timer); item.done.resolve(value);
    this.emit('change', this.queue.length > 0);
    if (index === 0) this.show();
  }
  cancel(id: string): void {
    const index = this.queue.findIndex(item => item.prompt.id === id);
    if (index >= 0) this.settle(index, this.queue[index].prompt.options[0].value);
  }
  cancelTurn(turnId: string): void {
    for (const item of [...this.queue]) if (item.prompt.turnId === turnId) this.cancel(item.prompt.id);
  }
  cancelAll(): void { for (const item of [...this.queue]) this.cancel(item.prompt.id); }
  close(): void { this.closed = true; this.cancelAll(); }
}

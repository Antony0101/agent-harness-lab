import type { WireMessage } from './transport.js';
import { object, safeText } from './util.js';
import { TerminalUI, type TerminalOptions } from './terminal.js';

type RenderOptions = TerminalOptions & { ui?: TerminalUI; verbose?: boolean; now?: () => number };
type TextItem = { pending: string; text: string; headed: boolean };

export class EventRenderer {
  private messages = new Map<string, TextItem>();
  private started = new Map<string, number>();
  private turnStarted?: number;
  private turns = 0;
  private ui: TerminalUI;
  private verbose: boolean;
  private now: () => number;
  constructor(write: (text: string) => void, private debug = false, options: RenderOptions = {}) {
    this.ui = options.ui ?? new TerminalUI(write, options);
    this.verbose = options.verbose ?? debug;
    this.now = options.now ?? Date.now;
  }
  private text(key: string, delta: string): void {
    const item = this.messages.get(key) ?? { pending: '', text: '', headed: false };
    const clean = safeText(delta);
    if (!item.headed && clean.trim()) { this.ui.heading('Codex'); item.headed = true; }
    item.text += clean; item.pending += clean;
    this.messages.set(key, item);
    // Whole lines/words keep readline's input separate from streamed output.
    const width = this.ui.width - 4;
    while (item.pending.includes('\n') || Array.from(item.pending).length > width) {
      const newline = item.pending.indexOf('\n');
      const characters = Array.from(item.pending);
      if (newline >= 0 && Array.from(item.pending.slice(0, newline)).length <= width) {
        this.ui.body(item.pending.slice(0, newline)); item.pending = item.pending.slice(newline + 1);
      } else {
        let cut = characters.slice(0, width + 1).lastIndexOf(' ');
        if (cut < width / 2) cut = width;
        this.ui.body(characters.slice(0, cut).join(''));
        item.pending = characters.slice(cut + (characters[cut] === ' ' ? 1 : 0)).join('');
      }
    }
  }
  private finishText(key: string, final?: string): void {
    const item = this.messages.get(key);
    if (!item) { if (final) { this.ui.heading('Codex'); this.ui.body(final); } return; }
    const clean = final === undefined ? undefined : safeText(final);
    if (clean?.startsWith(item.text) && clean.length > item.text.length) this.text(key, clean.slice(item.text.length));
    if (item.pending) { this.ui.body(item.pending); item.pending = ''; }
  }
  private elapsed(key: string): number | undefined {
    const start = this.started.get(key); this.started.delete(key);
    return start === undefined ? undefined : this.now() - start;
  }
  render(event: WireMessage): void {
    if (!event.method) return;
    const p = event.params && typeof event.params === 'object' ? object(event.params) : {};
    const key = `${String(p.turnId)}:${String(p.itemId)}`;
    switch (event.method) {
      case 'turn/started':
        this.messages.clear(); this.started.clear(); this.turnStarted = this.now();
        this.ui.rule(`TURN ${String(++this.turns).padStart(2, '0')}  ${this.ui.symbol('·', '/')}  WORKING`, 'accent');
        break;
      case 'item/agentMessage/delta': if (typeof p.delta === 'string') this.text(key, p.delta); break;
      case 'item/started': {
        const item = object(p.item);
        const itemKey = `${String(p.turnId)}:${String(item.id)}`;
        this.started.set(itemKey, this.now());
        if (item.type === 'commandExecution') this.ui.action('Run', String(item.command ?? 'Command'));
        if (item.type === 'fileChange') {
          const changes = Array.isArray(item.changes) ? item.changes.map(change => object(change).path).join(', ') : '';
          this.ui.action('Edit', changes || 'Applying file changes');
        }
        if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') this.ui.action('Tool', [item.server, item.tool].filter(Boolean).join(' / '));
        break;
      }
      case 'item/completed': {
        const item = object(p.item);
        const itemKey = `${String(p.turnId)}:${String(item.id)}`;
        if (item.type === 'agentMessage') this.finishText(itemKey, typeof item.text === 'string' ? item.text : undefined);
        if (item.type === 'commandExecution') {
          const success = typeof item.exitCode === 'number' ? item.exitCode === 0 : item.status === 'completed';
          this.ui.result(success ? 'Command completed' : `Command failed${item.exitCode == null ? '' : ` (exit ${item.exitCode})`}`, success, this.elapsed(itemKey));
          this.ui.preview(String(item.aggregatedOutput ?? ''), this.verbose, !success);
        }
        if (item.type === 'fileChange') this.ui.result(`Changes ${item.status ?? 'completed'}`, item.status === 'completed', this.elapsed(itemKey));
        if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
          const success = item.status === 'completed' && item.success !== false;
          this.ui.result(`Tool ${item.status ?? 'finished'}`, success, this.elapsed(itemKey));
          if (item.error) this.ui.preview(JSON.stringify(item.error), true, true);
          else if (this.verbose && item.result) this.ui.preview(JSON.stringify(item.result, null, 2), true);
        }
        break;
      }
      case 'turn/completed': {
        const turn = object(p.turn);
        for (const itemKey of this.messages.keys()) this.finishText(itemKey);
        const elapsed = this.turnStarted === undefined ? undefined : this.now() - this.turnStarted;
        const success = turn.status === 'completed';
        this.ui.result(`Turn ${String(turn.status)}`, success ? true : turn.status === 'interrupted' ? undefined : false, elapsed);
        if (turn.error) this.ui.body(errorText(turn.error), 'error');
        this.messages.clear(); this.started.clear(); this.turnStarted = undefined;
        break;
      }
      case 'error': case 'warning': case 'configWarning': case 'deprecationNotice':
        this.ui.notice(event.method === 'error' ? 'ERROR' : 'NOTICE', errorText(p.error ?? p), event.method === 'error' ? 'error' : 'warning'); break;
      default: if (this.debug) this.ui.info('event', event.method);
    }
  }
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const data = object(value);
    if (typeof data.message === 'string') return data.message;
  }
  return JSON.stringify(value);
}

// Playback deliberately knows nothing about the RPC client or tool dispatcher.
export function replay(events: Iterable<{ direction: string; payload: unknown }>, renderer: EventRenderer): void {
  for (const event of events) {
    if (event.direction !== 'in') continue;
    const payload = object(event.payload);
    if (typeof payload.method === 'string' && !('id' in payload)) renderer.render(payload as WireMessage);
  }
}

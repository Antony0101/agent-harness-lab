import { homedir } from 'node:os';
import { safeText } from './util.js';
import type { ApprovalPrompt } from './approvals.js';

type Tone = 'accent' | 'muted' | 'success' | 'warning' | 'error' | 'strong';
const colors: Record<Tone, string> = { accent: '36', muted: '90', success: '32', warning: '33', error: '31', strong: '1' };
export type TerminalOptions = { color?: boolean; unicode?: boolean; columns?: number | (() => number); home?: string };

// Only this presentation layer creates ANSI sequences. External strings are
// sanitized before styling; redirected output stays ordinary readable text.
export class TerminalUI {
  private color: boolean;
  private unicode: boolean;
  constructor(private sink: (text: string) => void, private options: TerminalOptions = {}) {
    this.color = options.color ?? false;
    this.unicode = options.unicode ?? true;
  }
  get width(): number {
    const columns = typeof this.options.columns === 'function' ? this.options.columns() : this.options.columns;
    return Math.max(24, Math.min(100, (columns ?? 88) - 4));
  }
  private paint(text: string, tone: Tone): string { return this.color ? `\x1b[${colors[tone]}m${text}\x1b[0m` : text; }
  private emit(text: string) { this.sink(text.endsWith('\n') ? text : text + '\n'); }
  symbol(unicode: string, ascii: string): string { return this.unicode ? unicode : ascii; }
  shorten(text: string, limit = this.width): string {
    const characters = Array.from(safeText(text).replace(/\s+/g, ' ').trim());
    return characters.length <= limit ? characters.join('') : characters.slice(0, Math.max(0, limit - 3)).join('') + '...';
  }
  path(text: string): string {
    const home = this.options.home ?? homedir();
    return home && (text === home || text.startsWith(home + '/')) ? '~' + text.slice(home.length) : text;
  }
  wrap(text: string, width = this.width - 4): string[] {
    const lines: string[] = [];
    for (let line of safeText(text).replace(/\t/g, '    ').split('\n')) {
      while (Array.from(line).length > width) {
        const characters = Array.from(line);
        let cut = characters.slice(0, width + 1).lastIndexOf(' ');
        if (cut < width / 2) cut = width;
        lines.push(characters.slice(0, cut).join(''));
        line = characters.slice(cut + (characters[cut] === ' ' ? 1 : 0)).join('');
      }
      lines.push(line);
    }
    return lines;
  }
  rule(label: string, tone: Tone = 'muted'): void {
    const title = this.shorten(label, this.width - 5);
    const bar = this.symbol('─', '-');
    this.emit('\n  ' + this.paint(`${bar}${bar} ${title} ${bar.repeat(Math.max(0, this.width - Array.from(title).length - 4))}`, tone));
  }
  info(label: string, value: string, tone: Tone = 'muted'): void {
    this.emit('  ' + this.paint(label.padEnd(10), tone) + ' ' + this.shorten(value, this.width - 12));
  }
  notice(title: string, body: string, tone: Tone = 'warning'): void {
    this.rule(title, tone);
    for (const line of this.wrap(body)) this.emit('    ' + this.paint(line, tone));
  }
  banner(workspace: string, writable: boolean): void {
    this.emit('\n  ' + this.paint('HARNESS', 'strong') + this.paint('  /  a local agent lab', 'muted'));
    this.emit('  ' + this.paint(this.symbol('─', '-').repeat(this.width), 'muted'));
    this.info('workspace', this.path(workspace));
    this.info('access', writable ? 'workspace write' : 'read only', writable ? 'warning' : 'accent');
  }
  prompt(state: 'idle' | 'running' | 'approval' = 'idle'): string {
    return '  ' + this.paint(state === 'approval' ? '?' : state === 'running' ? this.symbol('·', '.') : this.symbol('›', '>'), state === 'approval' ? 'warning' : 'accent') + ' ';
  }
  heading(label: string): void { this.emit('\n  ' + this.paint(label, 'strong')); }
  body(text: string, tone?: Tone): void {
    for (const line of this.wrap(text)) this.emit('    ' + (tone ? this.paint(line, tone) : line));
  }
  action(kind: string, label: string, tone: Tone = 'accent'): void {
    this.emit('\n  ' + this.paint(this.symbol('◆', '>') + ' ' + kind, tone));
    this.body(this.shorten(label, (this.width - 4) * 2), 'muted');
  }
  result(label: string, success: boolean | undefined, elapsed?: number): void {
    const tone = success === false ? 'error' : success === true ? 'success' : 'warning';
    const symbol = success === false ? this.symbol('×', 'x') : success === true ? this.symbol('✓', '+') : this.symbol('○', '-');
    this.emit('    ' + this.paint(`${symbol} ${safeText(label)}${elapsed === undefined ? '' : `  ${formatDuration(elapsed)}`}`, tone));
  }
  preview(text: string, full = false, failed = false): void {
    const lines = safeText(text).trimEnd().split('\n');
    if (lines.length === 1 && !lines[0]) return;
    const limit = full ? lines.length : failed ? 10 : 4;
    let emitted = 0;
    for (const line of lines) {
      for (const part of this.wrap(line)) {
        if (emitted >= limit) break;
        this.emit('    ' + this.paint(this.symbol('│ ', '| ') + part, failed ? 'warning' : 'muted'));
        emitted++;
      }
      if (emitted >= limit) break;
    }
    const total = lines.reduce((sum, line) => sum + this.wrap(line).length, 0);
    if (emitted < total) this.emit('    ' + this.paint(`... ${total - emitted} more lines. /events --full to inspect.`, 'muted'));
  }
  approval(prompt: ApprovalPrompt): void {
    this.rule('APPROVAL NEEDED', 'warning');
    this.body(prompt.title.replace('item/', '').replace('/requestApproval', '').replaceAll('/', ' '));
    const details = prompt.details && typeof prompt.details === 'object' ? prompt.details as Record<string, unknown> : {};
    for (const key of ['command', 'cwd', 'reason', 'entry', 'grantRoot']) {
      if (typeof details[key] === 'string') {
        this.body(key, 'muted');
        this.body(this.path(details[key]));
      }
    }
    if (details.permissions) this.body(JSON.stringify(details.permissions, null, 2), 'warning');
    if (!Object.keys(details).some(key => ['command', 'cwd', 'reason', 'entry', 'grantRoot', 'permissions'].includes(key))) this.body(JSON.stringify(prompt.details, null, 2));
    this.emit('');
    prompt.options.forEach((option, index) => this.emit('    ' + this.paint(`${index + 1}`, index === 0 ? 'muted' : 'accent') + '  ' + safeText(option.label)));
    this.emit('');
    this.body(`/approve ${prompt.id} <number>`, 'accent');
    this.body('Enter denies. Approval expires after two minutes.', 'muted');
  }
  fields(title: string, fields: Record<string, unknown>): void {
    this.rule(title);
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) {
      this.emit('  ' + this.paint(key.padEnd(12), 'muted') + ' ' + safeText(typeof value === 'object' ? JSON.stringify(value) : String(value)));
    }
  }
  // Compatibility for small status messages emitted by the controller.
  write(text: string): void {
    const clean = safeText(text);
    const match = clean.trim().match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
    if (!match) { this.emit(clean); return; }
    const [, tag, body] = match;
    if (tag === 'error' || tag === 'disconnected') { this.notice(tag === 'error' ? 'ERROR' : 'CONNECTION CLOSED', body, 'error'); return; }
    if (tag === 'workspace') return;
    if (tag.startsWith('session ')) { this.info('session', tag.slice(8)); return; }
    if (tag.startsWith('resumed ')) { this.info('resumed', tag.slice(8), 'success'); return; }
    if (tag.startsWith('workflow ')) { this.info(tag === 'workflow result' ? 'result' : 'workflow', body, 'accent'); return; }
    if (tag === 'context') { this.info('memory', this.path(body)); return; }
    if (tag === 'check') {
      const [status, ...output] = body.split('\n');
      this.heading('Acceptance check');
      this.result(status, status === 'passed');
      this.preview(output.join('\n'), false, status !== 'passed');
      return;
    }
    this.info(tag, body);
  }
}

export function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)}ms` : milliseconds < 60_000 ? `${(milliseconds / 1000).toFixed(1)}s` : `${Math.floor(milliseconds / 60_000)}m ${Math.round(milliseconds % 60_000 / 1000)}s`;
}

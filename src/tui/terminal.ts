import { TerminalUI, type Tone } from '../terminal.js';
import type { ApprovalPrompt } from '../approvals.js';
import { TuiModel, type Block } from './model.js';

/** Adapts existing command output into cards without changing command behavior. */
export class TuiTerminalUI extends TerminalUI {
  private current?: Block;
  constructor(readonly model: TuiModel) {
    super(text => model.add('notice', '', text.trimEnd()), { color: false, unicode: true });
  }
  override banner(workspace: string, writable: boolean): void { this.model.context.workspace = workspace; this.model.context.writable = writable; }
  override info(label: string, text: string, tone?: Tone): void {
    this.current = this.model.add('notice', label.toUpperCase(), text, tone === 'error' ? 'failed' : tone === 'warning' ? 'warning' : undefined);
  }
  override notice(title: string, body: string, tone?: Tone): void { this.info(title, body, tone); }
  override rule(title: string, tone?: Tone): void { this.heading(title, tone); }
  override heading(title: string, tone?: Tone): void { this.current = this.model.add(title.toLowerCase() === 'you' ? 'user' : 'section', title, '', tone === 'error' ? 'failed' : undefined); }
  override body(text: string, tone?: Tone): void {
    if (!this.current || !this.model.blocks.includes(this.current)) this.current = this.model.add('section', '', '', tone === 'error' ? 'failed' : undefined);
    this.model.append(this.current, (this.current.text ? '\n' : '') + text);
  }
  override action(kind: string, label: string): void { this.current = this.model.add('activity', `${kind} · ${label}`); }
  override result(label: string, success: boolean | undefined, elapsedMs?: number): void {
    this.current = this.model.add('notice', label, '', success === false ? 'failed' : success === true ? 'completed' : undefined);
    this.current.elapsedMs = elapsedMs;
  }
  override preview(text: string, full = false, failed = false): void {
    this.current = this.model.add('activity', 'Output', text, failed ? 'failed' : undefined); this.current.expanded = full;
  }
  override approval(prompt: ApprovalPrompt): void { this.model.setApproval(prompt); }
  override fields(title: string, fields: Record<string, unknown>): void {
    this.current = this.model.add('section', title, Object.entries(fields).filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}\n  ${typeof value === 'object' ? JSON.stringify(value, null, 2) : value}`).join('\n\n'));
  }
}

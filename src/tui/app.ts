import { InputDecoder, type InputKey } from './input.js';
import { TuiModel, VIEWS, type Form, type View } from './model.js';
import { renderScreen } from './render.js';
import { Editor } from './text.js';
import { message, safeText } from '../util.js';

export type TuiActions = {
  submit(text: string): boolean;
  interrupt(): void;
  exit(): void;
  approve(id: string, choice: number): boolean;
  refresh(view: View): Promise<void>;
  readMemory(id: string): Promise<string>;
  resumeSession(id: string): boolean;
  saveMemory(kind: string, title: string, body: string): Promise<void>;
  addTask(title: string, status: string): Promise<void>;
  updateTask(id: string, status: string): Promise<void>;
  toggleMemory(): void;
  context?(): void;
  failure?(error: Error): void;
};
const field = (label: string, text = '', options?: string[], multiline?: boolean) => {
  const editor = new Editor(); editor.set(text); return { label, editor, options, multiline };
};
function formError(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)) {
    const issue = error.issues[0] as { path?: unknown[]; message?: string } | undefined;
    if (issue?.message) return `${issue.path?.at(-1) ?? 'Field'}: ${issue.message}`;
  }
  return message(error);
}
export const keyboardHelp = `Keyboard shortcuts

Enter                 Send message or open selected item
Alt+Enter / Ctrl+J     Insert a newline
Tab                   Complete a slash command, otherwise next view
Shift+Tab             Previous view, preserving your draft
Alt+1 … Alt+5          Jump to a view, when passed through by your terminal
Ctrl+P                Search commands; Enter inserts the selected command
↑ / ↓                 Browse a panel; edit multiline drafts; message history
PgUp / PgDn           Scroll conversation or open details
Ctrl+Home / Ctrl+End   Scroll to beginning / follow live output
Ctrl+E                Expand or collapse tool output
Ctrl+F                Search memories (Memory view)
Ctrl+T                Toggle automatic recall (Memory view)
Ctrl+N                New task, memory, or conversation (in its view)
Ctrl+X                Change selected task status (Tasks view)
Ctrl+R                Refresh the current panel
Ctrl+S                Save a form
F1                    This help
Ctrl+C                Stop active work; exit when idle
Ctrl+Q                Stop work and exit

Approvals: ← / → selects a response; Enter confirms; Esc denies.
The initial response is always Deny. PgUp/PgDn scroll the full proposal.
Pasted text never submits a message or answers an approval.
If the terminal captures Alt+number, use Tab / Shift+Tab to change views.

Read operations use your selected workspace. Saving a memory or task
through a form is an explicit user action. Agent writes still require
--write and an interactive approval. Project checks require --write.

Use /help for every terminal command. --no-tui selects line mode.`;

/** Owns terminal modes and input, while all execution stays in the parent CLI. */
export class TuiApp {
  private started = false;
  private ended = false;
  private previous: string[] = [];
  private previousCursor = '';
  private scheduled?: NodeJS.Timeout;
  private ticker?: NodeJS.Timeout;
  private oldRaw = false;
  private wasPaused = true;
  private history: string[] = [];
  private historyIndex = 0;
  private draft = '';
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
  private decoder = new InputDecoder(key => this.key(key), text => this.paste(text));
  constructor(readonly model: TuiModel, private actions: TuiActions,
    private input: NodeJS.ReadStream = process.stdin, private output: NodeJS.WriteStream = process.stdout,
    private color = process.env.NO_COLOR === undefined) {}
  private onData = (chunk: Buffer | string) => { try { this.decoder.write(chunk); } catch (error) { this.fail(error); } };
  private onResize = () => { this.previous = []; this.schedule(); };
  private onEnd = () => { this.close(); this.actions.exit(); };
  private onError = (error: Error) => this.fail(error);
  private fail(error: unknown): void { this.close(); if (this.actions.failure) this.actions.failure(error instanceof Error ? error : new Error(message(error))); else this.actions.exit(); }
  start(): void {
    if (this.started || this.ended) return;
    if (!this.input.isTTY || !this.output.isTTY) throw new Error('The TUI requires an interactive terminal. Use --no-tui for line mode.');
    this.oldRaw = !!this.input.isRaw; this.wasPaused = this.input.isPaused(); this.started = true;
    try {
      this.input.setRawMode(true);
      this.input.on('data', this.onData); this.input.on('end', this.onEnd); this.input.on('error', this.onError);
      this.output.on('resize', this.onResize); this.output.on('error', this.onError);
      this.output.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?2004h\x1b[2J\x1b[H');
      this.input.resume(); this.paint();
      this.ticker = setInterval(() => {
        try {
          this.actions.context?.();
          if (this.model.busy || this.model.approval) { this.model.tick++; this.schedule(); }
        } catch (error) { this.fail(error); }
      }, 125);
    } catch (error) { this.close(); throw error; }
  }
  close(): void {
    if (this.ended) return; this.ended = true;
    clearTimeout(this.scheduled); clearInterval(this.ticker); this.decoder.close();
    if (this.started) {
      this.input.removeListener('data', this.onData); this.input.removeListener('end', this.onEnd); this.input.removeListener('error', this.onError);
      this.output.removeListener('resize', this.onResize); this.output.removeListener('error', this.onError);
      try { this.input.setRawMode(this.oldRaw); } catch { /* The input may have disconnected. */ }
      try { this.output.write('\x1b[0m\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l'); } catch { /* The output may have disconnected. */ }
      if (this.wasPaused || this.input.listenerCount('data') === 0) this.input.pause();
    }
    this.resolveClosed();
  }
  schedule(): void {
    if (!this.started || this.ended || this.scheduled) return;
    this.scheduled = setTimeout(() => { this.scheduled = undefined; try { this.paint(); } catch (error) { this.fail(error); } }, 24);
  }
  private paint(): void {
    if (this.ended) return;
    const frame = renderScreen(this.model, this.output.columns || 80, this.output.rows || 24, this.color);
    let output = '';
    frame.lines.forEach((line, index) => { if (line !== this.previous[index]) output += `\x1b[${index + 1};1H${line}`; });
    const cursor = frame.cursor ? `\x1b[${frame.cursor.y + 1};${frame.cursor.x + 1}H\x1b[?25h` : '';
    if (output || cursor !== this.previousCursor) this.output.write('\x1b[?25l' + output + cursor);
    this.previous = frame.lines; this.previousCursor = cursor;
  }
  private notify(text: string): void { this.model.toast = safeText(text); this.model.changed(); }
  private async run(work: () => Promise<void>): Promise<void> {
    try { await work(); } catch (error) { this.notify(message(error)); } finally { this.model.changed(); }
  }
  async view(view: View): Promise<void> {
    this.model.view = view; this.model.toast = ''; this.model.focusSelection = true; this.model.changed();
    await this.run(() => this.actions.refresh(view));
  }
  private edit(editor: Editor, key: InputKey): void {
    switch (key.name) {
      case 'text': editor.insert(key.text ?? ''); break;
      case 'left': editor.left(); break; case 'right': editor.right(); break;
      case 'backspace': editor.backspace(); break; case 'delete': editor.delete(); break;
      case 'home': editor.home(); break; case 'end': editor.end(); break;
      case 'deleteword': editor.deleteWord(); break; case 'clear': editor.set(''); break;
      case 'up': editor.vertical(-1); break; case 'down': editor.vertical(1); break;
    }
  }
  private paste(text: string): void {
    if (!this.model.screenReady || this.model.approval || this.model.shownApproval || this.model.dialog || this.model.form?.submitting) return;
    const target = this.model.form?.fields[this.model.form.active] ?? undefined;
    if (target?.options) return;
    const editor = target?.editor ?? this.model.palette ?? this.model.composer;
    editor.insert(target && !target.multiline ? text.replace(/\s*\n\s*/g, ' ') : text);
    this.model.suggestion = 0; this.model.changed();
  }
  private openForm(kind: Exclude<Form['kind'], 'status'>): void {
    if (this.model.busy && kind !== 'search') { this.notify('Stop active work before saving a memory or task.'); return; }
    this.model.form = kind === 'memory' ? { kind, title: 'Save a workspace memory', active: 0, submitting: false,
      fields: [field('Kind', 'facts', ['facts', 'decisions', 'preferences', 'lessons', 'summaries']), field('Title'), field('Body · Alt+Enter for a newline', '', undefined, true)] }
      : kind === 'task' ? { kind, title: 'Add a task', active: 0, submitting: false, fields: [field('Title'), field('Status', 'pending', ['pending', 'in_progress', 'completed'])] }
        : { kind, title: 'Search memories', active: 0, submitting: false, fields: [field('Query · empty shows all', this.model.memoryQuery)] };
    this.model.changed();
  }
  private async saveForm(): Promise<void> {
    const form = this.model.form; if (!form || form.submitting) return;
    form.submitting = true; form.error = undefined; this.model.changed();
    try {
      if (form.kind === 'memory') await this.actions.saveMemory(...form.fields.map(item => item.editor.text) as [string, string, string]);
      else if (form.kind === 'task') await this.actions.addTask(form.fields[0].editor.text, form.fields[1].editor.text);
      else if (form.kind === 'status' && this.statusTaskId) await this.actions.updateTask(this.statusTaskId, form.fields[0].editor.text);
      else { this.model.memoryQuery = form.fields[0].editor.text.trim(); await this.actions.refresh('memory'); }
      if (this.model.form === form) this.model.form = undefined;
    } catch (error) { form.error = formError(error); }
    finally { form.submitting = false; this.model.changed(); }
  }
  /** Public for deterministic input tests and the offline preview. */
  key(key: InputKey): void {
    const model = this.model;
    if (key.name === 'interrupt') { this.actions.interrupt(); return; }
    if (key.name === 'quit') { this.actions.exit(); return; }
    if (key.name === 'redraw') { this.previous = []; model.changed(); return; }
    if (!model.screenReady || (!model.approval && model.shownApproval)) return;
    if (model.approval) {
      const prompt = model.approval;
      if (model.shownApproval !== prompt.id) return;
      if (key.name === 'left' || key.name === 'right') model.approvalChoice = (model.approvalChoice + (key.name === 'left' ? -1 : 1) + prompt.options.length) % prompt.options.length;
      if (key.name === 'pageup' || key.name === 'up') model.approvalScroll -= key.name === 'up' ? 1 : 5;
      if (key.name === 'pagedown' || key.name === 'down') model.approvalScroll += key.name === 'down' ? 1 : 5;
      if (key.name === 'top') model.approvalScroll = 0;
      if (key.name === 'bottom') model.approvalScroll = Number.MAX_SAFE_INTEGER;
      if (['escape', 'enter'].includes(key.name)) {
        if (!this.actions.approve(prompt.id, key.name === 'escape' ? 0 : model.approvalChoice)) this.notify('This approval has expired.');
      }
      model.changed(); return;
    }
    if (model.dialog) {
      if (['escape', 'enter'].includes(key.name)) model.dialog = undefined;
      else if (['up', 'pageup'].includes(key.name)) model.dialog.scroll -= key.name === 'up' ? 1 : 8;
      else if (['down', 'pagedown'].includes(key.name)) model.dialog.scroll += key.name === 'down' ? 1 : 8;
      else if (key.name === 'top') model.dialog.scroll = 0;
      else if (key.name === 'bottom') model.dialog.scroll = Number.MAX_SAFE_INTEGER;
      model.changed(); return;
    }
    if (model.form) {
      const form = model.form; if (form.submitting) return;
      const active = form.fields[form.active];
      if (key.name === 'escape') model.form = undefined;
      else if (key.name === 'tab' || key.name === 'backtab') form.active = (form.active + (key.name === 'tab' ? 1 : -1) + form.fields.length) % form.fields.length;
      else if (key.name === 'save' || (key.name === 'enter' && form.kind === 'search')) void this.saveForm();
      else if (key.name === 'enter') form.active = (form.active + 1) % form.fields.length;
      else if (key.name === 'newline' && active.multiline) active.editor.insert('\n');
      else if (active.options && ['left', 'right', 'up', 'down'].includes(key.name)) {
        const delta = ['left', 'up'].includes(key.name) ? -1 : 1; active.editor.set(active.options[(active.options.indexOf(active.editor.text) + delta + active.options.length) % active.options.length]);
      } else if (!active.options) this.edit(active.editor, key);
      model.changed(); return;
    }
    if (model.palette) {
      if (key.name === 'escape' || key.name === 'palette') model.palette = undefined;
      else if (key.name === 'up') model.paletteIndex--;
      else if (key.name === 'down') model.paletteIndex++;
      else if (key.name === 'enter') { const command = model.paletteCommands()[model.paletteIndex]; if (command) model.composer.set(command[0]); model.palette = undefined; }
      else { this.edit(model.palette, key); model.paletteIndex = 0; }
      model.changed(); return;
    }
    if (key.name === 'palette') { model.palette = new Editor(); model.paletteIndex = 0; }
    else if (key.name === 'help') model.dialog = { title: 'Keyboard help', text: keyboardHelp, scroll: 0 };
    else if (/^view[1-5]$/.test(key.name)) void this.view(VIEWS[Number(key.name.slice(-1)) - 1]);
    else if (key.name === 'tab' || key.name === 'backtab') {
      const suggestions = model.suggestions();
      if (key.name === 'tab' && suggestions.length) { model.composer.set(suggestions[model.suggestion % suggestions.length][0]); model.suggestion = 0; }
      else void this.view(VIEWS[(VIEWS.indexOf(model.view) + (key.name === 'tab' ? 1 : -1) + VIEWS.length) % VIEWS.length]);
    } else if (['pageup', 'pagedown', 'top', 'bottom'].includes(key.name)) {
      const delta = key.name === 'pageup' ? -model.viewport.height + 2 : model.viewport.height - 2;
      model.scroll[model.view] = key.name === 'top' ? 0 : key.name === 'bottom' && model.view === 'conversation' ? null : key.name === 'bottom' ? model.viewport.total : Math.max(0, model.viewport.start + delta);
    } else if (key.name === 'expand') model.details = !model.details;
    else if (key.name === 'refresh') void this.run(() => this.actions.refresh(model.view));
    else if (key.name === 'find' && model.view === 'memory') this.openForm('search');
    else if (key.name === 'toggle' && model.view === 'memory') this.actions.toggleMemory();
    else if (key.name === 'new') {
      if (model.view === 'memory') this.openForm('memory'); else if (model.view === 'tasks') this.openForm('task');
      else if (!model.busy && this.actions.submit('/new')) model.composer.set('');
    } else if (key.name === 'status' && model.view === 'tasks') {
      const task = model.tasks[model.selection.tasks];
      if (model.busy) this.notify('Stop active work before editing tasks.');
      else if (task) {
        model.form = { kind: 'status', title: 'Change task status', active: 0, submitting: false, fields: [field(task.title, task.status, ['pending', 'in_progress', 'completed'])] };
        // A dedicated modal action retains the selected ID; no update happens on arrow keys.
        this.statusTaskId = task.id;
      }
    } else if (key.name === 'enter') {
      if (model.composer.text.trim()) {
        const text = model.composer.text;
        if (this.actions.submit(text)) {
          this.history.push(text); if (this.history.length > 100) this.history.shift(); this.historyIndex = this.history.length;
          model.composer.set(''); model.suggestion = 0; model.scroll.conversation = null; model.toast = '';
          if (!text.trim().startsWith('/')) model.view = 'conversation';
        }
      } else if (model.view === 'memory') {
        const memory = model.memories[model.selection.memory];
        if (memory) void this.run(async () => {
          const text = await this.actions.readMemory(memory.id);
          if (model.view === 'memory' && model.memories[model.selection.memory]?.id === memory.id && !model.dialog && !model.form) model.dialog = { title: memory.title, text, scroll: 0 };
        });
      } else if (model.view === 'tools') {
        const tool = model.tools[model.selection.tools]; if (tool) model.dialog = { title: tool.name, text: `${tool.description}\n\nEffect: ${tool.effect}\n\n${tool.example}`, scroll: 0 };
      } else if (model.view === 'sessions') {
        const session = model.sessions[model.selection.sessions]; if (session && this.actions.resumeSession(session.id)) model.view = 'conversation';
      } else if (model.view === 'tasks') {
        const task = model.tasks[model.selection.tasks];
        if (task) model.dialog = { title: 'Task details', text: `${task.title}\n\nStatus: ${task.status.replaceAll('_', ' ')}\n\nID: ${task.id}\n\nCtrl+X opens the status form.\n/tool todo_update supports title edits and removal using the current revision.`, scroll: 0 };
      }
    } else if (key.name === 'newline') model.composer.insert('\n');
    else if (key.name === 'eof') { if (!model.composer.text) this.actions.exit(); else model.composer.delete(); }
    else if (key.name === 'escape') { model.toast = ''; model.suggestion = 0; }
    else if (['up', 'down'].includes(key.name) && !model.composer.text.includes('\n')) {
      const delta = key.name === 'up' ? -1 : 1;
      if (model.suggestions().length) model.suggestion = Math.max(0, model.suggestion + delta);
      else if (model.view !== 'conversation' && !model.composer.text) { model.selection[model.view] = Math.max(0, model.selection[model.view] + delta); model.focusSelection = true; }
      else {
        if (this.historyIndex === this.history.length) this.draft = model.composer.text;
        this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + delta));
        model.composer.set(this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex]);
      }
    } else { this.edit(model.composer, key); model.suggestion = 0; }
    model.changed();
  }
  private statusTaskId?: string;
}

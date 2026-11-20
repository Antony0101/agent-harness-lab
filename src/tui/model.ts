import type { ApprovalPrompt } from '../approvals.js';
import type { WireMessage } from '../transport.js';
import { object, safeText } from '../util.js';
import { Editor } from './text.js';

export type View = 'conversation' | 'tools' | 'memory' | 'tasks' | 'sessions';
export const VIEWS: View[] = ['conversation', 'tools', 'memory', 'tasks', 'sessions'];
export type Block = { id: string; kind: 'user' | 'assistant' | 'activity' | 'notice' | 'section'; title: string; text: string;
  status?: string; elapsedMs?: number; expanded?: boolean; version: number; startedAt: number; truncated?: boolean };
export type ToolCard = { name: string; description: string; effect: string; example: string };
export type MemoryCard = { id: string; title: string; kind: string; source: string; snippet?: string };
export type TaskCard = { id: string; title: string; status: string };
export type SessionCard = { id: string; status: string; updatedAt: string; error?: string };
export type Context = { workspace: string; writable: boolean; runtime: string; model: string; state: string;
  session?: string; thread?: string; memory: boolean; recalled: number; recallCharacters: number; workflow?: boolean; directTool?: boolean };
export type Form = { kind: 'task' | 'status' | 'memory' | 'search'; title: string; fields: Array<{ label: string; editor: Editor; options?: string[]; multiline?: boolean }>;
  active: number; submitting: boolean; error?: string };
export type Dialog = { title: string; text: string; scroll: number };
export const COMMANDS = [
  ['/help', 'Keyboard help and commands'], ['/new', 'Start a fresh conversation'], ['/status', 'Inspect session and runtime'],
  ['/stop', 'Interrupt active work'], ['/sessions', 'List saved sessions'], ['/resume ', 'Resume a saved session'],
  ['/memory', 'Inspect memory and last recall'], ['/memory list', 'List saved knowledge'], ['/memory search ', 'Search workspace memories'],
  ['/memory add ', 'Save an explicit memory'], ['/memory on', 'Enable automatic recall'], ['/memory off', 'Disable automatic recall'],
  ['/tools', 'Browse workspace tool schemas'], ['/tool ', 'Run a local tool'], ['/tasks', 'Inspect workflow records'],
  ['/events --full', 'Inspect saved events'], ['/history', 'Inspect runtime history'], ['/fix ', 'Run the fixture workflow'], ['/exit', 'Save and exit'],
] as const;

export class TuiModel {
  view: View = 'conversation';
  composer = new Editor();
  context: Context;
  blocks: Block[] = [];
  tools: ToolCard[] = []; memories: MemoryCard[] = []; tasks: TaskCard[] = []; sessions: SessionCard[] = [];
  taskRevision = 0;
  memoryQuery = '';
  loading = false;
  loadError = '';
  selection: Record<View, number> = { conversation: 0, tools: 0, memory: 0, tasks: 0, sessions: 0 };
  scroll: Record<View, number | null> = { conversation: null, tools: 0, memory: 0, tasks: 0, sessions: 0 };
  focusSelection = false;
  viewport = { start: 0, height: 1, total: 0 };
  details = false;
  palette: Editor | undefined;
  paletteIndex = 0;
  suggestion = 0;
  form: Form | undefined;
  dialog: Dialog | undefined;
  approval: ApprovalPrompt | undefined;
  approvalChoice = 0;
  approvalScroll = 0;
  shownApproval: string | undefined;
  screenReady = true;
  toast = '';
  turns = 0;
  dropped = false;
  tick = 0;
  private nextId = 0;
  constructor(context: Context, readonly changed: () => void = () => {}) { this.context = context; }
  get busy(): boolean { return !['idle', 'ready', 'disconnected', 'unknown'].includes(this.context.state) || !!this.context.workflow || !!this.context.directTool; }
  add(kind: Block['kind'], title: string, text = '', status?: string, id?: string): Block {
    const block: Block = { id: id ?? `local-${++this.nextId}`, kind, title: safeText(title), text: '', status, version: 0, startedAt: Date.now() };
    this.blocks.push(block); this.update(block, text);
    while (this.blocks.length > 250 || (this.blocks.length > 1 && this.blocks.reduce((sum, item) => sum + item.text.length, 0) > 1024 * 1024)) { this.blocks.shift(); this.dropped = true; }
    this.changed(); return block;
  }
  update(block: Block, text: string): void { block.truncated = text.length > 65536; block.text = safeText(text).slice(0, 65536); block.version++; this.changed(); }
  append(block: Block, text: string): void { if (!block.truncated) this.update(block, block.text + text); }
  setApproval(prompt?: ApprovalPrompt): void {
    if (this.approval !== prompt) { this.approvalChoice = 0; this.approvalScroll = 0; if (prompt) this.shownApproval = undefined; }
    this.approval = prompt; this.changed();
  }
  suggestions(): Array<readonly [string, string]> {
    const text = this.composer.text;
    return text.startsWith('/') && !text.includes('\n') ? COMMANDS.filter(([command]) => command.startsWith(text) && command !== text).slice(0, 6) : [];
  }
  paletteCommands(): Array<readonly [string, string]> {
    const query = this.palette?.text.toLowerCase() ?? '';
    return COMMANDS.filter(([command, description]) => `${command} ${description}`.toLowerCase().includes(query));
  }
  reset(): void { this.blocks = []; this.turns = 0; this.scroll.conversation = null; this.dropped = false; this.changed(); }
  event(event: WireMessage, full = false): void {
    const p = event.params && typeof event.params === 'object' ? object(event.params) : {};
    const key = `${String(p.turnId)}:${String(p.itemId)}`;
    const find = (id: string) => this.blocks.find(block => block.id === id);
    if (event.method === 'turn/started') { this.turns++; this.context.state = 'running'; }
    if (event.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      const block = find(key) ?? this.add('assistant', 'CODEX', '', 'streaming', key); this.append(block, p.delta);
    }
    if (event.method === 'item/started' || event.method === 'item/completed') {
      const item = object(p.item); const id = `${String(p.turnId)}:${String(item.id)}`;
      if (item.type === 'agentMessage' && typeof item.text === 'string' && event.method === 'item/completed') {
        const block = find(id) ?? this.add('assistant', 'CODEX', '', undefined, id);
        this.update(block, item.text); block.status = undefined;
      } else if (['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange'].includes(String(item.type))) {
        const title = item.type === 'commandExecution' ? String(item.command ?? 'Command')
          : item.type === 'fileChange' ? `Edit ${Array.isArray(item.changes) ? item.changes.map(change => object(change).path).join(', ') : 'workspace files'}`
            : [item.server, item.tool].filter(Boolean).join(' / ') || 'Tool';
        const block = find(id) ?? this.add('activity', title, '', 'running', id);
        if (event.method === 'item/completed') {
          const failed = item.exitCode != null ? item.exitCode !== 0 : item.status !== 'completed' || item.success === false || !!item.error;
          block.status = failed ? `failed${item.exitCode == null ? '' : ` · exit ${item.exitCode}`}` : `completed${item.exitCode == null ? '' : ` · exit ${item.exitCode}`}`;
          block.elapsedMs = Date.now() - block.startedAt;
          this.update(block, String(item.aggregatedOutput ?? (item.error ? JSON.stringify(item.error, null, 2) : item.result ? JSON.stringify(item.result, null, 2) : '')));
        }
        block.expanded ||= full;
      }
    }
    if (event.method === 'turn/completed') {
      const turn = object(p.turn); this.context.state = 'idle';
      for (const value of Array.isArray(turn.items) ? turn.items : []) {
        const item = object(value); if (item.type !== 'agentMessage' || typeof item.text !== 'string') continue;
        const id = `${String(turn.id)}:${String(item.id)}`; const block = find(id) ?? this.add('assistant', 'CODEX', '', undefined, id);
        this.update(block, item.text); block.status = undefined;
      }
      for (const block of this.blocks) if (block.status === 'streaming') block.status = undefined;
      this.add('notice', `Turn ${String(turn.status)}`, turn.error ? JSON.stringify(turn.error, null, 2) : '', turn.status === 'failed' ? 'failed' : String(turn.status));
    }
    if (event.method?.startsWith('harness/tool/')) {
      const phase = event.method.split('/').at(-1); const result = p.result && typeof p.result === 'object' ? object(p.result) : {};
      if (phase === 'started') this.add('activity', String(p.name), '', 'running', `local-tool:${String(p.name)}`);
      else {
        const block = this.blocks.findLast(item => item.id === `local-tool:${String(p.name)}` && item.status === 'running') ?? this.add('activity', String(p.name));
        block.status = phase === 'failed' || result.passed === false ? `failed${result.code == null ? '' : ` · exit ${result.code}`}` : `completed${result.code == null ? '' : ` · exit ${result.code}`}${result.truncated ? ' · truncated' : ''}`;
        block.elapsedMs = typeof p.elapsedMs === 'number' ? p.elapsedMs : undefined;
        this.update(block, typeof p.error === 'string' ? p.error : typeof result.output === 'string' ? result.output : JSON.stringify(result, null, 2));
        block.expanded ||= full;
        if (p.name === 'todo_list' || p.name === 'todo_update') {
          if (Array.isArray(result.tasks) && typeof result.revision === 'number') {
            this.tasks = result.tasks as TaskCard[]; this.taskRevision = result.revision;
            this.update(block, `${this.tasks.length} tasks · revision ${this.taskRevision}\n${this.tasks.map(task => `${task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◐' : '○'} ${task.title}`).join('\n')}`);
          }
        }
      }
    }
    if (['error', 'warning', 'configWarning', 'deprecationNotice'].includes(event.method ?? '')) this.add('notice', event.method === 'error' ? 'ERROR' : 'NOTICE', typeof p.message === 'string' ? p.message : JSON.stringify(p.error ?? p), event.method === 'error' ? 'failed' : 'warning');
    this.changed();
  }
}

import { homedir } from 'node:os';
import { TuiModel, VIEWS, type Block } from './model.js';
import { cellWidth, clip, displayWidth, flow, graphemes, wrap } from './text.js';

type Ink = 'text' | 'muted' | 'accent' | 'purple' | 'success' | 'warning' | 'error' | 'strong' | 'selected' | 'code';
const inks: Record<Ink, string> = {
  text: '38;5;252;48;5;234', muted: '38;5;245;48;5;234', accent: '1;38;5;80;48;5;234',
  purple: '1;38;5;183;48;5;234', success: '38;5;114;48;5;234', warning: '38;5;222;48;5;234',
  error: '38;5;210;48;5;234', strong: '1;38;5;255;48;5;234', selected: '1;38;5;80;48;5;238', code: '38;5;151;48;5;235',
};
type Cell = { text: string; ink: Ink };
type Line = { text: string; ink: Ink };
export type Frame = { lines: string[]; plain: string[]; cursor?: { x: number; y: number } };
class Canvas {
  cells: Cell[][];
  cursor?: Frame['cursor'];
  constructor(readonly width: number, readonly height: number) {
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ text: ' ', ink: 'text' })));
  }
  put(x: number, y: number, text: string, ink: Ink = 'text', max = this.width - x): void {
    if (y < 0 || y >= this.height) return;
    let used = 0;
    for (const part of graphemes(clip(text, Math.max(0, max)))) {
      const width = cellWidth(part);
      if (!width) continue;
      if (x >= 0 && x + width <= this.width) {
        this.cells[y][x] = { text: part, ink };
        for (let i = 1; i < width; i++) this.cells[y][x + i] = { text: '', ink };
      }
      x += width; used += width; if (used >= max) break;
    }
  }
  fill(x: number, y: number, width: number, height: number, ink: Ink = 'text'): void {
    for (let row = y; row < y + height; row++) this.put(x, row, ' '.repeat(Math.max(0, width)), ink, width);
  }
  box(x: number, y: number, width: number, height: number, title = '', ink: Ink = 'muted'): void {
    this.fill(x, y, width, height);
    this.put(x, y, '╭' + '─'.repeat(Math.max(0, width - 2)) + '╮', ink);
    this.put(x, y + height - 1, '╰' + '─'.repeat(Math.max(0, width - 2)) + '╯', ink);
    for (let row = y + 1; row < y + height - 1; row++) { this.put(x, row, '│', ink); this.put(x + width - 1, row, '│', ink); }
    if (title) this.put(x + 2, y, ` ${title} `, ink, width - 4);
  }
  frame(color: boolean): Frame {
    const plain = this.cells.map(row => row.map(cell => cell.text).join(''));
    const lines = color ? this.cells.map(row => {
      let result = ''; let previous: Ink | undefined;
      for (const cell of row) {
        if (cell.ink !== previous) { result += `\x1b[0;${inks[cell.ink]}m`; previous = cell.ink; }
        result += cell.text;
      }
      return result + '\x1b[0m';
    }) : plain;
    return { lines, plain, cursor: this.cursor };
  }
}
const line = (text = '', ink: Ink = 'text'): Line => ({ text, ink });
const shortPath = (text: string) => text.startsWith(homedir() + '/') ? '~' + text.slice(homedir().length) : text;
const label = (text: string) => text.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const elapsed = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
const blockCache = new WeakMap<Block, { key: string; lines: Line[] }>();
function blockLines(block: Block, width: number, details: boolean): Line[] {
  const key = `${width}:${details}:${block.version}:${block.status}:${block.expanded}`;
  const cached = blockCache.get(block); if (cached?.key === key) return cached.lines;
  const failed = block.status?.startsWith('failed');
  const tone: Ink = failed ? 'error' : block.kind === 'user' ? 'purple' : block.kind === 'assistant' ? 'accent' : block.kind === 'notice' ? 'muted' : 'strong';
  const icon = block.kind === 'user' ? '◆' : block.kind === 'assistant' ? '✦' : failed ? '×' : block.status === 'running' ? '◌' : block.kind === 'activity' ? '↳' : '·';
  const status = block.status && block.status !== 'streaming' && !block.title.toLowerCase().endsWith(block.status) ? `  ${block.status}` : '';
  const time = block.elapsedMs === undefined ? '' : ` · ${elapsed(block.elapsedMs)}`;
  const result = [line(`${icon} ${block.title}${status}${time}`, tone)];
  const all = flow(block.text, Math.max(1, width - 2));
  const limit = block.kind === 'activity' && !details && !block.expanded ? (failed ? 10 : 4) : all.length;
  let fenced = false;
  for (const text of all.slice(0, limit)) {
    if (text.startsWith('```')) { fenced = !fenced; result.push(line(`  ${text.slice(3) || '─'.repeat(Math.min(24, width - 4))}`, 'muted')); continue; }
    const heading = /^#{1,6}\s/.test(text);
    result.push(line('  ' + (fenced ? text : text.replace(/^#{1,6}\s/, '').replace(/\*\*([^*]+)\*\*/g, '$1')),
      fenced ? 'code' : heading ? 'strong' : block.kind === 'notice' ? failed ? 'error' : 'muted' : 'text'));
  }
  if (all.length > limit) result.push(line(`  … ${all.length - limit} more lines · Ctrl+E to expand`, 'muted'));
  if (block.truncated) result.push(line('  … display limit reached; inspect the saved event log', 'warning'));
  result.push(line()); blockCache.set(block, { key, lines: result }); return result;
}
function collection(model: TuiModel, width: number): { lines: Line[]; offsets: number[] } {
  const result: Line[] = []; const offsets: number[] = [];
  if (model.view === 'memory') result.push(line(`Recall ${model.context.memory ? 'on' : 'off'} · ${model.context.recalled} selected for the last task · /memory inspects sources`, 'muted'), line());
  if (model.loadError) result.push(...wrap(model.loadError, width).map(text => line(text, 'error')), line('Ctrl+R to retry', 'muted'), line());
  const cards = model.view === 'tools' ? model.tools : model.view === 'memory' ? model.memories : model.view === 'tasks' ? model.tasks : model.sessions;
  if (!cards.length) {
    const empty = model.loading ? 'Loading…' : model.view === 'memory' ? 'No memories yet. Save something worth remembering.' : model.view === 'tasks' ? 'A clear workspace. Add your first task.' : 'No saved sessions in this workspace.';
    return { lines: [...result, line(empty, 'muted')], offsets };
  }
  for (let i = 0; i < cards.length; i++) {
    offsets.push(result.length); const selected = i === model.selection[model.view]; const tone: Ink = selected ? 'selected' : 'strong'; const prefix = selected ? '› ' : '  ';
    if (model.view === 'tools') {
      const tool = model.tools[i]; result.push(line(prefix + tool.name + '  [' + tool.effect + ']', tone));
      result.push(...wrap(tool.description, width - 2).slice(0, 3).map(text => line('  ' + text, 'muted')));
    } else if (model.view === 'memory') {
      const memory = model.memories[i]; result.push(line(prefix + memory.title, tone), line(`  ${memory.kind} · ${memory.source}`, 'muted'));
      if (memory.snippet) result.push(...wrap(memory.snippet, width - 2).slice(0, 2).map(text => line('  ' + text)));
    } else if (model.view === 'tasks') {
      const task = model.tasks[i]; const mark = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◐' : '○';
      result.push(line(`${prefix}${mark} ${task.title}`, tone), line(`    ${label(task.status)}`, task.status === 'completed' ? 'success' : 'muted'));
    } else {
      const session = model.sessions[i]; result.push(line(prefix + session.id, tone), line(`  ${session.status} · ${session.updatedAt}`, 'muted'));
    }
    result.push(line());
  }
  return { lines: result, offsets };
}
function drawEditor(canvas: Canvas, editor: { text: string; cursor: number }, x: number, y: number, width: number, height: number, placeholder: string): void {
  const before = wrap(editor.text.slice(0, editor.cursor), width); const all = wrap(editor.text, width);
  let cursorRow = before.length - 1; let cursorColumn = displayWidth(before.at(-1)!);
  if (cursorColumn === width) { cursorRow++; cursorColumn = 0; }
  const start = Math.max(0, cursorRow - height + 1);
  if (!editor.text) canvas.put(x, y, placeholder, 'muted', width);
  else all.slice(start, start + height).forEach((text, i) => canvas.put(x, y + i, text, 'text', width));
  canvas.cursor = { x: x + cursorColumn, y: y + cursorRow - start };
}
function modal(canvas: Canvas, title: string, wantedHeight: number): { x: number; y: number; width: number; height: number } {
  const width = Math.min(96, canvas.width - 6); const height = Math.min(canvas.height - 4, wantedHeight);
  const x = Math.floor((canvas.width - width) / 2); const y = Math.floor((canvas.height - height) / 2);
  canvas.fill(0, 3, canvas.width, canvas.height - 3);
  canvas.box(x, y, width, height, title, 'accent'); canvas.cursor = undefined; return { x, y, width, height };
}
export function renderScreen(model: TuiModel, columns: number, rows: number, color = true): Frame {
  const width = Math.max(1, Math.min(400, columns)); const height = Math.max(1, Math.min(150, rows)); const canvas = new Canvas(width, height);
  if (width < 44 || height < 17) {
    model.screenReady = false;
    model.shownApproval = undefined;
    canvas.put(1, 1, 'Learning Harness', 'accent'); canvas.put(1, 3, 'Resize to at least 44 × 17 to continue.', 'muted');
    canvas.put(1, 5, 'Ctrl+C stop / exit · Ctrl+Q quit', 'muted'); return canvas.frame(color);
  }
  model.screenReady = true;
  const ctx = model.context;
  canvas.put(2, 1, '◈  LEARNING HARNESS', 'accent');
  const disconnected = ['unknown', 'disconnected'].includes(ctx.state);
  const state = model.approval ? 'approval needed' : model.busy ? `${['◐', '◓', '◑', '◒'][model.tick % 4]} ${ctx.workflow ? 'workflow' : ctx.directTool ? 'running tool' : label(ctx.state)}` : disconnected ? `● ${ctx.state}` : '● ready';
  canvas.put(width - displayWidth(state) - 3, 1, state, model.approval ? 'warning' : disconnected ? 'error' : model.busy ? 'accent' : 'success');
  let tabX = 2;
  VIEWS.forEach((view, index) => {
    const name = width >= 80 ? `${index + 1} ${view[0].toUpperCase() + view.slice(1)}` : ['Chat', 'Tools', 'Memory', 'Tasks', 'Sessions'][index];
    canvas.put(tabX, 3, ` ${name} `, model.view === view ? 'selected' : 'muted'); tabX += displayWidth(name) + 3;
  });
  const editorHeight = Math.max(2, Math.min(5, wrap(model.composer.text, width - 8).length + 1));
  const composerY = height - editorHeight - 4;
  const bodyY = 6; const bodyHeight = Math.max(1, composerY - bodyY - 1);
  const sidebar = width >= 108 ? 28 : 0; const contentWidth = width - sidebar - 6;
  const title = model.view === 'conversation' ? 'CONVERSATION' : model.view === 'memory' && model.memoryQuery ? `MEMORY · ${model.memoryQuery}` : model.view.toUpperCase();
  canvas.put(2, 5, title, 'muted', contentWidth);
  let content: Line[]; let offsets: number[] = [];
  if (model.view === 'conversation') {
    content = model.blocks.flatMap(block => blockLines(block, contentWidth, model.details));
    if (model.dropped) content.unshift(line('Earlier messages are in the session event log.', 'muted'), line());
    if (!content.length) content = [line(), line('  Build something. Learn how it works.', 'strong'), line(),
      ...flow('Describe a task below. Codex works in your selected workspace, and asks before approved writes or commands.', contentWidth - 4).map(text => line('  ' + text, 'muted')),
      line(), line('  Ctrl+P commands', 'accent'), line('  Tab → view    Shift+Tab ← view', 'accent'), line(), line('  Your messages and sessions stay in local history.', 'muted')];
  } else ({ lines: content, offsets } = collection(model, contentWidth));
  let start = model.scroll[model.view] ?? Math.max(0, content.length - bodyHeight);
  if (model.focusSelection && offsets.length) {
    const selected = Math.min(Math.max(0, model.selection[model.view]), offsets.length - 1); model.selection[model.view] = selected;
    const top = offsets[selected]; const bottom = (offsets[selected + 1] ?? content.length) - 1;
    if (top < start) start = top; else if (bottom >= start + bodyHeight) start = Math.min(top, bottom - bodyHeight + 1);
    model.scroll[model.view] = start; model.focusSelection = false;
  }
  start = Math.max(0, Math.min(start, Math.max(0, content.length - bodyHeight)));
  model.viewport = { start, height: bodyHeight, total: content.length };
  content.slice(start, start + bodyHeight).forEach((row, index) => canvas.put(2, bodyY + index, row.text, row.ink, contentWidth));
  if (content.length > bodyHeight) {
    canvas.put(contentWidth + 3, bodyY, '▴', 'muted'); canvas.put(contentWidth + 3, bodyY + bodyHeight - 1, '▾', 'muted');
    const thumb = Math.round((bodyHeight - 3) * start / Math.max(1, content.length - bodyHeight));
    canvas.put(contentWidth + 3, bodyY + 1 + thumb, '┃', 'accent');
  }
  if (sidebar) {
    const x = width - sidebar + 1; for (let y = 5; y < composerY; y++) canvas.put(x - 2, y, '│', 'muted');
    let y = 5;
    const entry = (name: string, value: string, ink: Ink = 'text') => {
      canvas.put(x, y++, name, 'muted', sidebar - 4);
      for (const text of wrap(value, sidebar - 5).slice(0, 3)) canvas.put(x, y++, text, ink, sidebar - 4);
      y++;
    };
    entry('WORKSPACE', shortPath(ctx.workspace)); entry('ACCESS', ctx.writable ? 'Workspace write' : 'Read only', ctx.writable ? 'warning' : 'success');
    entry('MODEL', ctx.model); entry('MEMORY', ctx.memory ? `On · ${ctx.recalled} recalled\n${ctx.recallCharacters} / 6,000 chars` : 'Off');
    if (y + 3 < composerY) entry('SESSION', ctx.session?.slice(0, 18) ?? 'Starting…');
  }
  canvas.box(1, composerY, width - 2, editorHeight + 2, model.busy ? ' Draft · work in progress ' : ' Message ', 'accent');
  drawEditor(canvas, model.composer, 4, composerY + 1, width - 8, editorHeight, 'Ask Codex, or / for commands…');
  const hints = model.view === 'conversation' ? 'Enter send  Ctrl+J newline  Ctrl+P commands  PgUp scroll  Ctrl+E details'
    : model.view === 'memory' ? '↑↓ select  Enter read  Ctrl+F search  Ctrl+N save  Ctrl+T recall'
      : model.view === 'tasks' ? '↑↓ select  Ctrl+N add  Ctrl+X change status  Ctrl+R refresh'
        : model.view === 'tools' ? '↑↓ select  Enter inspect  Ctrl+R refresh' : '↑↓ select  Enter resume  Ctrl+N new session';
  canvas.put(2, height - 2, hints, 'muted', width - 4);
  const navigation = model.suggestions().length ? 'Tab completes · Shift+Tab view' : 'Tab/Shift+Tab views';
  const footer = width < 64 ? ` · ${navigation}` : ` · ${ctx.writable ? 'write' : 'read only'} · ${navigation} · Ctrl+Q quit`;
  const status = model.toast || (model.scroll.conversation !== null && model.view === 'conversation' ? 'Browsing history · Ctrl+End returns to live output' : clip(shortPath(ctx.workspace), Math.max(8, width - displayWidth(footer) - 4), true) + footer);
  canvas.put(2, height - 1, status, model.toast ? 'warning' : 'muted', width - 4);
  const suggestions = model.suggestions();
  if (suggestions.length && !model.form && !model.dialog && !model.approval && !model.palette) {
    const y = Math.max(bodyY, composerY - suggestions.length - 2); canvas.box(2, y, Math.min(width - 4, 76), suggestions.length + 2, ' Tab completes ');
    suggestions.forEach(([command, description], i) => canvas.put(4, y + i + 1, `${command.padEnd(22)} ${description}`, i === model.suggestion % suggestions.length ? 'selected' : 'muted', Math.min(width - 8, 72)));
  }
  if (model.dialog) {
    const box = modal(canvas, model.dialog.title, height - 4); const lines = wrap(model.dialog.text, box.width - 4); const visible = box.height - 4;
    model.dialog.scroll = Math.max(0, Math.min(model.dialog.scroll, Math.max(0, lines.length - visible)));
    lines.slice(model.dialog.scroll, model.dialog.scroll + visible).forEach((text, i) => canvas.put(box.x + 2, box.y + 1 + i, text, 'text', box.width - 4));
    canvas.put(box.x + 2, box.y + box.height - 2, `Esc close · ↑↓ / PgUp/PgDn scroll · ${model.dialog.scroll + 1}/${Math.max(1, lines.length)}`, 'muted', box.width - 4);
  }
  if (model.palette) {
    const commands = model.paletteCommands(); const box = modal(canvas, 'Commands', Math.min(17, height - 4));
    drawEditor(canvas, model.palette, box.x + 2, box.y + 2, box.width - 4, 1, 'Type a command or search…');
    const count = box.height - 7; model.paletteIndex = Math.max(0, Math.min(model.paletteIndex, commands.length - 1));
    const start = Math.max(0, model.paletteIndex - count + 1);
    commands.slice(start, start + count).forEach(([command, description], i) => canvas.put(box.x + 2, box.y + 4 + i, `${command.padEnd(22)} ${description}`, start + i === model.paletteIndex ? 'selected' : 'muted', box.width - 4));
    canvas.put(box.x + 2, box.y + box.height - 2, '↑↓ select · Enter insert command · Esc close', 'muted', box.width - 4);
  }
  if (model.form) {
    const form = model.form; const box = modal(canvas, form.title, height - 4); let y = box.y + 2;
    const fieldHeight = Math.max(1, Math.min(5, box.height - form.fields.length * 3 - 4));
    // Small terminals show one field at a time, keeping Save/Cancel reachable.
    const compact = box.height < 19 && form.fields.length > 1;
    if (compact) { canvas.put(box.x + 2, y++, `Field ${form.active + 1} of ${form.fields.length} · Tab to move`, 'muted', box.width - 4); y++; }
    form.fields.forEach((field, i) => {
      if (compact && i !== form.active) return;
      const active = i === form.active; canvas.put(box.x + 2, y++, field.label, active ? 'accent' : 'muted', box.width - 4);
      if (field.options) {
        canvas.put(box.x + 3, y++, `${active ? '‹ ' : ''}${label(field.editor.text)}${active ? ' ›' : ''}`, active ? 'selected' : 'text', box.width - 6);
        if (active) canvas.cursor = undefined;
      } else if (active) { drawEditor(canvas, field.editor, box.x + 3, y, box.width - 6, field.multiline ? fieldHeight : 1, 'Type here…'); y += field.multiline ? fieldHeight : 1; }
      else { wrap(field.editor.text || '—', box.width - 6).slice(0, field.multiline ? fieldHeight : 1).forEach((text, j) => canvas.put(box.x + 3, y + j, text, 'text', box.width - 6)); y += field.multiline ? fieldHeight : 1; }
      y++;
    });
    if (form.error) canvas.put(box.x + 2, box.y + box.height - 3, form.error, 'error', box.width - 4);
    canvas.put(box.x + 2, box.y + box.height - 2, form.submitting ? 'Saving…' : 'Tab next · ←→ choose · Ctrl+S save · Esc cancel', 'muted', box.width - 4);
  }
  if (model.approval) {
    const prompt = model.approval;
    const countdown = prompt.expiresAt === undefined ? '' : ` · ${Math.max(0, Math.ceil((prompt.expiresAt - Date.now()) / 1000))}s`;
    const box = modal(canvas, `Permission required${countdown}`, height - 4);
    canvas.put(box.x + 2, box.y + 1, prompt.title.replace('item/', '').replace('/requestApproval', '').replaceAll('/', ' '), 'warning', box.width - 4);
    const lines = wrap(typeof prompt.details === 'string' ? prompt.details : JSON.stringify(prompt.details, null, 2), box.width - 4);
    const options = prompt.options.flatMap((option, i) => flow(`${i === model.approvalChoice ? '●' : '○'} ${option.label}`, box.width - 4).map(text => ({ text, selected: i === model.approvalChoice })));
    const visible = Math.max(1, box.height - 6 - options.length); model.approvalScroll = Math.max(0, Math.min(model.approvalScroll, Math.max(0, lines.length - visible)));
    lines.slice(model.approvalScroll, model.approvalScroll + visible).forEach((text, i) => canvas.put(box.x + 2, box.y + 3 + i, text, 'text', box.width - 4));
    options.forEach((option, i) => canvas.put(box.x + 2, box.y + box.height - 2 - options.length + i, option.text, option.selected ? 'selected' : 'muted', box.width - 4));
    canvas.put(box.x + 2, box.y + box.height - 2, `←→ choose · Enter confirm · Esc deny · PgUp/PgDn details (${model.approvalScroll + 1}/${Math.max(1, lines.length)})`, 'muted', box.width - 4);
    model.shownApproval = prompt.id;
  } else model.shownApproval = undefined;
  return canvas.frame(color);
}

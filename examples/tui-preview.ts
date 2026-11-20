import { parseArgs } from 'node:util';
import { TuiApp, keyboardHelp } from '../src/tui/app.js';
import { TuiModel, VIEWS } from '../src/tui/model.js';
import { renderScreen } from '../src/tui/render.js';
import { toolCatalog } from '../src/tui/catalog.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// A deliberately offline demo: no Codex, sockets, subprocesses, or saved files.
const { values } = parseArgs({ options: { snapshot: { type: 'boolean' }, columns: { type: 'string' }, rows: { type: 'string' } } });
let app: TuiApp;
const model = new TuiModel({ workspace: '~/projects/learning-harness · OFFLINE PREVIEW', writable: true, runtime: 'Demo runtime', model: 'Offline sample data',
  state: 'idle', session: 'demo-session', memory: true, recalled: 2, recallCharacters: 1340 }, () => app?.schedule());
model.tools = toolCatalog(resolve(fileURLToPath(new URL('..', import.meta.url))));
model.memories = [
  { id: 'facts/demo.md', title: 'Markdown owns the content', kind: 'facts', source: 'memory/facts/demo.md', snippet: 'SQLite is a disposable search index. Notes remain readable in any editor.' },
  { id: 'preferences/demo.md', title: 'Keep the learning stack small', kind: 'preferences', source: 'memory/preferences/demo.md' },
];
model.tasks = [{ id: '1', title: 'Build a terminal interface that feels calm and clear', status: 'completed' },
  { id: '2', title: 'Explore the tools and memory panels', status: 'in_progress' }, { id: '3', title: 'Try the approval flow', status: 'pending' }];
model.sessions = [{ id: 'demo-session', status: 'idle', updatedAt: 'Today' }];
model.add('notice', 'OFFLINE PREVIEW', 'Sample data only · Tab / Shift+Tab views · send “approval”.');
model.add('user', 'YOU', 'Help me understand how this harness remembers things.');
model.add('activity', 'workspace_search', 'src/memory/service.ts:41  export class MemoryService {', 'completed');
model.add('assistant', 'CODEX', 'Memory stays local and easy to inspect.\n\n## Two parts, one source of truth\n- Markdown files hold your saved facts, preferences, and decisions.\n- SQLite makes those files searchable. You can rebuild it at any time.\n\nBefore each task, the harness recalls relevant notes within a 6,000-character budget. Saving a new memory is always explicit.\n\nPress Tab twice to open the Memory view and explore your notes.');
if (values.snapshot) {
  const columns = Number(values.columns ?? 112); const rows = Number(values.rows ?? 34);
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) throw new Error('Use positive integer --columns and --rows.');
  process.stdout.write(renderScreen(model, columns, rows, false).plain.join('\n') + '\n');
} else {
  let timer: NodeJS.Timeout | undefined;
  const exit = () => { clearTimeout(timer); app.close(); };
  app = new TuiApp(model, {
    submit: text => {
      if (text.startsWith('/')) {
        const view = text === '/tools' ? 'tools' : text.startsWith('/memory') ? 'memory' : text === '/sessions' ? 'sessions' : text === '/tasks' ? 'tasks' : undefined;
        if (view) void app.view(view);
        else if (text === '/exit') exit();
        else if (text === '/new') model.reset();
        else model.dialog = { title: 'Preview help', text: keyboardHelp, scroll: 0 };
        return true;
      }
      if (model.busy) { model.toast = 'A preview turn is active. Ctrl+C stops it.'; return false; }
      model.add('user', 'YOU', text); model.context.state = 'running';
      timer = setTimeout(() => {
        if (/approval/i.test(text)) {
          model.setApproval({ id: 'preview-approval', title: 'Save a workspace memory',
            details: { kind: 'lessons', title: 'How approvals work', body: 'The parent harness shows the complete proposal before executing an agent write.', destination: 'memory/lessons/<uuid>.md', preview: 'This demo never writes a file.' },
            options: [{ label: 'Deny', value: false }, { label: 'Approve once', value: true }] });
        } else {
          model.add('assistant', 'CODEX', 'This is an offline interaction preview.\n\nUse Tab / Shift+Tab to explore each view. Save a sample task or memory with Ctrl+N, search commands with Ctrl+P, or send “approval” to inspect a permission dialog.\n\nRun npm start to use the same interface with your signed-in Codex runtime.');
          model.context.state = 'idle';
        }
        model.changed();
      }, 700);
      return true;
    },
    interrupt: () => { if (!model.busy) exit(); else { clearTimeout(timer); model.setApproval(undefined); model.context.state = 'idle'; model.add('notice', 'Stopped', 'Preview work interrupted.'); } },
    exit,
    approve: (id, choice) => {
      if (id !== model.approval?.id) return false;
      model.setApproval(undefined); model.context.state = 'idle'; model.add('notice', choice ? 'Approved · preview only' : 'Denied', 'No files were changed.'); return true;
    },
    refresh: async view => { if (!VIEWS.includes(view)) throw new Error('Unknown view'); },
    readMemory: async id => { const memory = model.memories.find(item => item.id === id)!; return `${memory.source}\n\n# ${memory.title}\n\n${memory.snippet ?? 'Keep dependencies small and behavior easy to understand.'}`; },
    resumeSession: () => { model.toast = 'Already viewing the sample session.'; return false; },
    saveMemory: async (kind, title, body) => {
      if (!title.trim() || !body.trim()) throw new Error('Add a title and body.');
      model.memories.push({ id: `preview-${model.memories.length}`, title, kind, source: 'Preview · in memory only', snippet: body }); model.toast = 'Sample memory added · not saved to disk';
    },
    addTask: async (title, status) => {
      if (!title.trim()) throw new Error('Add a task title.');
      model.tasks.push({ id: String(model.tasks.length + 1), title, status }); model.toast = 'Sample task added · not saved to disk';
    },
    updateTask: async (id, status) => { model.tasks.find(task => task.id === id)!.status = status; },
    toggleMemory: () => { model.context.memory = !model.context.memory; model.changed(); },
  });
  process.on('SIGTERM', exit); process.on('SIGINT', exit);
  try { app.start(); await app.closed; } finally { app.close(); clearTimeout(timer); process.removeListener('SIGTERM', exit); process.removeListener('SIGINT', exit); }
}

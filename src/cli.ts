import { createInterface, clearLine, cursorTo } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Approvals } from './approvals.js';
import { CodexClient, createCodexRpc } from './codex.js';
import { findCodex, runtimeVersion } from './runtime.js';
import { Store } from './store.js';
import { Session } from './session.js';
import { EventRenderer, replay } from './events.js';
import { approvalBroker } from './tools/approval-ipc.js';
import { MemoryService } from './memory/service.js';
import { memoryCommand } from './memory/commands.js';
import { memoryAgentHandler } from './memory/agent.js';
import { fixWorkflow, fixtureCheck } from './workflow.js';
import { message, safeText } from './util.js';
import { TerminalUI } from './terminal.js';
import { randomUUID } from 'node:crypto';
import { WorkspaceTools } from './workspace-tools/service.js';
import { listWorkspaceTools, runTerminalTool } from './workspace-tools/commands.js';
import { TuiApp } from './tui/app.js';
import { TuiModel, type View, type TaskCard } from './tui/model.js';
import { TuiTerminalUI } from './tui/terminal.js';
import { toolCatalog } from './tui/catalog.js';
import { kindSchema } from './memory/types.js';
import { MEMORY_CONTEXT_HEADER } from './memory/service.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  workspace: { type: 'string' }, write: { type: 'boolean', default: false },
  model: { type: 'string' }, prompt: { type: 'string' }, resume: { type: 'string' },
  replay: { type: 'string' }, debug: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false }, plain: { type: 'boolean', default: false },
  'no-tui': { type: 'boolean', default: false },
  'no-memory': { type: 'boolean', default: false },
  memory: { type: 'string' },
  tools: { type: 'boolean', default: false }, tool: { type: 'string' }, args: { type: 'string' },
  'data-dir': { type: 'string' }, help: { type: 'boolean', default: false },
} });
let input: ReturnType<typeof createInterface> | undefined;
let promptState: () => 'idle' | 'running' | 'approval' = () => 'idle';
const redraw = !!process.stdin.isTTY && !!process.stdout.isTTY && !values.plain && values.prompt === undefined;
let tui: TuiApp | undefined;
let tuiModel: TuiModel | undefined;
const lineUI = new TerminalUI(text => {
  if (input && redraw) { clearLine(process.stdout, 0); cursorTo(process.stdout, 0); }
  process.stdout.write(text);
  if (input && redraw) { input.setPrompt(ui.prompt(promptState())); input.prompt(true); }
}, {
  color: !!process.stdout.isTTY && !values.plain && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb',
  unicode: !values.plain, columns: () => process.stdout.columns || 88,
});
let ui: TerminalUI = lineUI;
const write = (text: string) => ui.write(text);
const renderer = (full = false) => new EventRenderer(write, values.debug, { ui, verbose: full || values.verbose || values.debug,
  onEvent: tuiModel ? event => tuiModel!.event(event, full || values.verbose || values.debug) : undefined });
const help = `Learning Harness — a small, inspectable personal Codex client

npm start -- [--workspace PATH] [--write] [--model NAME]
             [--prompt TEXT] [--resume LOCAL_ID] [--replay LOCAL_ID]
             [--no-memory] [--verbose] [--plain] [--no-tui] [--debug] [--data-dir PATH]
             [--memory "COMMAND"]
             [--tools | --tool NAME --args JSON]

Default: read-only fixtures/sample-project; ChatGPT sign-in required.
Finds Codex on PATH or in VS Code extensions; CODEX_BIN overrides discovery.
No API-key fallback.
Noninteractive agent input denies approval requests. --replay, --memory, and tools work offline.
Interactive terminals open the full-screen TUI. Ctrl+P commands; F1 keyboard help.
--no-tui selects line mode; --plain disables styling and the TUI.
Command output is compact by default. --verbose expands it.

/new                    Create a new conversation
/status                 Inspect application state and IDs
/stop                   Interrupt active work
/sessions               List saved local sessions
/resume <local-id>      Resume runtime history; never replay actions
/events [--full] [id]   Replay events; --full expands saved command output
/history                Inspect the ten most recent runtime turns
/memory [on|off]        Inspect memory configuration and last recall
/memory list [kind]     List workspace memories
/memory search <query>  Search saved memories
/memory read <id>       Read a complete Markdown source
/memory add <kind> <title> :: <body>
/memory forget <id>     Remove a saved memory
/memory rebuild         Rebuild SQLite from workspace Markdown
/memory import <kind> <file>
/fix <task>             Implement/check/repair/review the fixture (--write)
/tasks                  List workflow records for manual inspection
/tools                  List the five workspace tools and inputs
/tool <name> <JSON>      Run a workspace tool directly; checks require --write
/approve <id> <number>  Answer the current approval with its exact ID
/help                   Show these commands
/exit                   Close child processes and exit
`;

async function main() {
  if (values.help) { write(help); return; }
  const modes = [!!values.replay, values.memory !== undefined, values.tools, values.tool !== undefined, values.prompt !== undefined || values.resume !== undefined];
  if (modes.filter(Boolean).length > 1) throw new Error('Choose one mode: --replay, --memory, --tools, --tool, or live --prompt/--resume');
  if (values.args !== undefined && values.tool === undefined) throw new Error('--args requires --tool');
  if (values.tools) { listWorkspaceTools(ui); return; }
  const store = new Store(values['data-dir'] ?? resolve(root, '.harness'));
  if (values.replay) {
    const history = await store.events(values.replay);
    for (const warning of history.warnings) write(`[log] ${warning}\n`);
    replay(history.events, renderer()); return;
  }
  await store.init();
  const workspace = resolve(values.workspace ?? resolve(root, 'fixtures/sample-project'));
  if (values.tool !== undefined) {
    const trace = `tools-${randomUUID()}`;
    ui.info('trace', trace);
    const toolRenderer = renderer();
    const tools = await WorkspaceTools.open(workspace, store.root, { observe: async event => {
      await store.append(trace, { direction: 'local', method: `tool/${event.phase}`, payload: event });
      if (event.phase !== 'started') toolRenderer.render({ method: `harness/tool/${event.phase}`, params: event });
    } });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
      const result = await runTerminalTool(values.tool, values.args ?? '{}', tools, ui, values.write, controller.signal) as { passed?: boolean };
      if (result.passed === false) process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      await tools.close(); await store.flush();
    }
    return;
  }
  const memoryWarning = (text: string) => ui.notice('MEMORY', text);
  if (values.memory !== undefined) {
    const memories = await MemoryService.open(workspace, store.root, memoryWarning);
    let enabled = !values['no-memory'];
    try { await memoryCommand(values.memory, memories, ui, { enabled: () => enabled, setEnabled: value => { enabled = value; } }); }
    finally { await memories.close(); }
    return;
  }
  const runtime = await findCodex();
  const options = { bin: runtime.bin, workspace, root, writable: values.write, model: values.model, debug: values.debug };
  const version = await runtimeVersion(options.bin);
  const useTui = !!process.stdin.isTTY && !!process.stdout.isTTY && values.prompt === undefined && !values.plain && !values['no-tui'] && process.env.TERM !== 'dumb';
  if (!useTui) { ui.banner(options.workspace, options.writable); ui.info('runtime', `${version} / ${runtime.source}`); }
  if (values.debug) ui.info('executable', runtime.bin);
  try {
    const generatedVersion = (await readFile(resolve(root, 'generated/runtime-version.txt'), 'utf8')).trim();
    if (generatedVersion !== version) throw new Error(`Protocol generated for ${generatedVersion}, executable is ${version}. Run npm run protocol.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Run npm run protocol before starting the live client.');
    throw error;
  }
  if (useTui) {
    tuiModel = new TuiModel({ workspace, writable: options.writable, runtime: version, model: values.model ?? 'Codex default',
      state: 'initializing', memory: !values['no-memory'], recalled: 0, recallCharacters: 0 }, () => tui?.schedule());
    tuiModel.tools = toolCatalog(root); ui = new TuiTerminalUI(tuiModel);
  }
  const interactive = !!process.stdin.isTTY && values.prompt === undefined;
  const approvals = new Approvals(interactive, write, 120_000, ui);
  let session: Session | undefined;
  const memories = await MemoryService.open(workspace, store.root, memoryWarning);
  options.workspace = memories.workspace;
  const confirmTool = (name: string, args: unknown, signal?: AbortSignal) => session?.toolApproval(name, args, signal) ?? Promise.resolve(false);
  const provenance = () => ({ sessionId: session?.record?.id, turnId: session?.turnId });
  const toolRenderer = renderer();
  const tools = await WorkspaceTools.open(memories.workspace, store.root, { observe: async event => {
    await store.append(session?.traceId ?? 'tool-startup', { direction: 'local', method: `tool/${event.phase}`, payload: event });
    if (tuiModel || event.phase !== 'started') toolRenderer.render({ method: `harness/tool/${event.phase}`, params: event });
  } });
  const withTurn = (signal?: AbortSignal) => {
    const signals = [signal, session?.toolSignal].filter((item): item is AbortSignal => !!item);
    return signals.length ? AbortSignal.any(signals) : undefined;
  };
  const memoryHandler = memoryAgentHandler(memories, confirmTool, provenance);
  const bridge = await approvalBroker(confirmTool, (name, args, signal) => memoryHandler(name, args, withTurn(signal)),
    (name, args, signal) => tools.call(name, args, { origin: 'agent', writable: options.writable, confirm: confirmTool, signal: withTurn(signal) }))
    .catch(async error => { await tools.close(); await memories.close(); throw error; });
  const rpc = createCodexRpc(options, bridge);
  promptState = () => approvals.active ? 'approval' : session?.busy || toolOperation ? 'running' : 'idle';
  let workflow: AbortController | undefined;
  let toolOperation: AbortController | undefined;
  let activeTask: Promise<unknown> | undefined;
  let closing = false;
  let cleanupPromise: Promise<void> | undefined;
  const close = () => cleanupPromise ??= (async () => {
    closing = true; session?.shutdown();
    const terminalInput = input; input = undefined;
    approvals.close(); workflow?.abort(); toolOperation?.abort(); tools.cancelAll(); terminalInput?.close();
    tui?.close();
    await rpc.close(); await bridge.close(); await tools.close(); await memories.close();
    try { await store.flush(); } catch (error) { write(`[storage] ${message(error)}\n`); }
  })();
  const stop = async () => {
    workflow?.abort(); toolOperation?.abort(); tools.cancelAll(); approvals.cancelAll();
    if (session?.busy) await session.interrupt();
  };
  let interrupting = false;
  const ctrlC = () => {
    if (closing || interrupting || (!session?.busy && !workflow && !toolOperation)) { void close(); return; }
    interrupting = true;
    void stop().catch(error => write(`${message(error)}\n`)).finally(() => { interrupting = false; });
  };
  process.on('SIGINT', ctrlC);
  const terminate = () => { void close(); };
  process.on('SIGTERM', terminate);
  rpc.transport.on('diagnostic', (text: string) => { if (values.debug) { if (tuiModel) ui.info('runtime debug', safeText(text)); else process.stderr.write(safeText(text)); } });
  rpc.on('disconnect', () => tools.cancelAll());
  try {
    const client = new CodexClient(rpc, options);
    session = new Session(client, store, approvals, renderer(), write, version, 600_000, memories);
    session.memory = !values['no-memory'];
    await client.initialize();
    if (values.resume) await session.resume(values.resume); else await session.fresh();
    write(`[workspace] ${options.workspace} (${options.writable ? 'workspace-write' : 'read-only'})\n`);
    if (values.prompt !== undefined) {
      ui.heading('You'); ui.body(values.prompt);
      const result = await session.run(values.prompt);
      if (result.status !== 'completed') process.exitCode = 1;
      return;
    }
    ui.info('ready', '/help commands  /stop interrupt  /exit quit', 'accent');
    function launch(task: Promise<unknown>) {
      activeTask = task;
      void task.catch(error => { process.exitCode = 1; write(`[error] ${message(error)}\n`); })
        .finally(() => {
          if (activeTask === task) activeTask = undefined;
          updateContext();
          if (!closing && interactive && input) { input.setPrompt(ui.prompt(promptState())); input.prompt(true); }
        });
    }
    function updateContext() {
      if (!tuiModel) return;
      const next = { ...session!.snapshot(), workflow: !!workflow, directTool: !!toolOperation,
        model: options.model ?? 'Codex default', recalled: session!.memory ? memories.lastRecall.items.length : 0,
        recallCharacters: session!.memory ? memories.lastRecall.characters : 0 };
      if (JSON.stringify(tuiModel.context) !== JSON.stringify(next)) { tuiModel.context = next; tuiModel.changed(); }
    }
    async function hydrate() {
      if (!tuiModel) return;
      const history = await store.events(session!.traceId); tuiModel.reset();
      for (const event of history.events) {
        if (event.direction === 'out' && event.method === 'turn/start') {
          const payload = event.payload as { params?: { input?: Array<{ text?: string }> } };
          for (const item of payload.params?.input ?? []) if (typeof item.text === 'string') {
            tuiModel.add('user', 'YOU', item.text.replace(/^Current user task:\n/, '').split(MEMORY_CONTEXT_HEADER)[0]);
          }
        } else replay([event], renderer());
      }
      for (const warning of history.warnings) ui.notice('HISTORY', warning);
      updateContext();
    }
    let refreshVersion = 0;
    async function refresh(view: View) {
      if (!tuiModel) return;
      const current = ++refreshVersion; tuiModel.loading = true; tuiModel.loadError = ''; tuiModel.changed();
      try {
        if (view === 'memory') {
          const items = tuiModel.memoryQuery ? await memories.search(tuiModel.memoryQuery, 20) : await memories.list();
          if (current === refreshVersion) tuiModel.memories = items;
        } else if (view === 'tasks') {
          const file = await tools.todos.list();
          if (current === refreshVersion) { tuiModel.tasks = file.tasks; tuiModel.taskRevision = file.revision; }
        } else if (view === 'sessions') {
          const records = await store.sessions();
          if (current === refreshVersion) tuiModel.sessions = records.filter(record => !('error' in record) && record.workspace === memories.workspace)
            .map(record => { if ('error' in record) throw new Error(record.error); return { id: record.id, status: record.lastKnownStatus, updatedAt: record.updatedAt }; })
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        }
      } catch (error) { if (current === refreshVersion) { tuiModel.loadError = message(error); if (view === 'memory') tuiModel.memories = []; } throw error; }
      finally { if (current === refreshVersion) { tuiModel.loading = false; tuiModel.focusSelection = true; tuiModel.changed(); } }
    }
    async function command(line: string) {
      const [cmd, ...parts] = line.trim().split(/\s+/);
      const arg = parts.join(' ');
      if (cmd === '/approve') {
        if (parts.length !== 2 || !approvals.answer(parts[0], parts[1])) write('Approval is stale, ID is incorrect, or decision is invalid.\n');
        return;
      }
      if (!line.trim()) { if (approvals.active) approvals.answer(approvals.active.id, ''); return; }
      if (cmd === '/exit') { await close(); return; }
      if (cmd === '/stop') { await stop(); return; }
      if (cmd === '/status') { ui.fields('SESSION', { ...session!.snapshot(), workflow: !!workflow, directTool: !!toolOperation }); return; }
      if (cmd === '/help') { if (tuiModel) { tuiModel.dialog = { title: 'Commands · F1 for keyboard shortcuts', text: help, scroll: 0 }; tuiModel.changed(); } else write(help); return; }
      if (cmd === '/tools') { if (tui) await tui.view('tools'); else listWorkspaceTools(ui); return; }
      if (cmd === '/sessions') {
        if (tui) { await tui.view('sessions'); return; }
        ui.rule('SAVED SESSIONS');
        for (const record of await store.sessions()) {
          ui.body(record.id);
          ui.body('error' in record ? record.error : `${record.lastKnownStatus} / ${ui.path(record.workspace)}`, 'muted');
        }
        return;
      }
      if (cmd === '/events') {
        const full = parts.includes('--full');
        const ids = parts.filter(part => part !== '--full');
        if (ids.length > 1) throw new Error('Usage: /events [--full] [local-id]');
        const history = await store.events(ids[0] || session!.traceId);
        for (const warning of history.warnings) write(`[log] ${warning}\n`);
        if (tuiModel) {
          let text = '';
          const previewUI = new TerminalUI(chunk => { text += chunk; }, { color: false });
          replay(history.events, new EventRenderer(chunk => { text += chunk; }, values.debug, { ui: previewUI, verbose: full }));
          tuiModel.dialog = { title: full ? 'Saved events · full output' : 'Saved events', text: text || 'No saved events.', scroll: 0 }; tuiModel.changed(); return;
        }
        ui.rule(full ? 'SAVED EVENTS / FULL OUTPUT' : 'SAVED EVENTS');
        replay(history.events, renderer(full)); return;
      }
      if (cmd === '/tasks') {
        const { readdir } = await import('node:fs/promises');
        write((await readdir(resolve(store.root, 'tasks'))).filter(file => file.endsWith('.json')).join('\n') + '\n'); return;
      }
      if (activeTask || session!.busy || workflow) throw new Error('Work is active. Use /stop, /status, or answer the pending approval.');
      if (cmd === '/new') { await session!.fresh(); tuiModel?.reset(); updateContext(); return; }
      if (cmd === '/resume') { await session!.resume(arg); await hydrate(); return; }
      if (cmd === '/history') { ui.rule('RUNTIME HISTORY'); ui.body(JSON.stringify(await client.history(session!.record!.codexThreadId), null, 2)); return; }
      if (cmd === '/tool') {
        const match = /^\/tool\s+(\S+)\s+([\s\S]+)$/.exec(line.trim());
        if (!match) throw new Error('Usage: /tool <name> <JSON arguments>');
        toolOperation = new AbortController();
        try {
          const result = await runTerminalTool(match[1], match[2], tools, ui, options.writable, toolOperation.signal) as { passed?: boolean };
          if (result.passed === false) process.exitCode = 1;
        } finally { toolOperation = undefined; }
        return;
      }
      if (cmd === '/memory') {
        await memoryCommand(line.trim().slice('/memory'.length), memories, ui, {
          enabled: () => session!.memory, setEnabled: value => { session!.memory = value; }, provenance,
        });
        return;
      }
      if (cmd === '/fix') {
        if (!options.writable) throw new Error('Restart with --write to use the fixture workflow');
        if (!arg) throw new Error('Usage: /fix <task>');
        workflow = new AbortController();
        try {
          const check = fixtureCheck(root, options.workspace, workflow.signal);
          const result = await fixWorkflow({ task: arg, sessionId: session!.record!.id, run: prompt => session!.run(prompt), check, store, signal: workflow.signal, write });
          if (result.stage !== 'completed') process.exitCode = 1;
          write(`[workflow result] ${result.stage}\n`);
        } finally { workflow = undefined; }
        return;
      }
      if (cmd.startsWith('/')) throw new Error(`Unknown command ${cmd}. Use /help.`);
      tuiModel?.add('user', 'YOU', line);
      const result = await session!.run(line);
      if (result.status !== 'completed') process.exitCode = 1;
    }
    // Do not await agent turns in the line callback: /stop and approvals stay responsive.
    const submit = (line: string): boolean => {
      if (closing) return false;
      const control = /^\/(approve|stop|status|help|exit|sessions|events|tasks|tools)(?:\s|$)/.test(line.trim()) || !line.trim();
      if (!control && (activeTask || session!.busy || workflow)) { if (tuiModel) { tuiModel.toast = 'Work is active. Ctrl+C stops it; your draft is preserved.'; tuiModel.changed(); } else write('Busy. Use /stop or /status.\n'); return false; }
      if (control) void command(line).catch(error => write(`[error] ${message(error)}\n`));
      else launch(command(line));
      updateContext(); return true;
    };
    if (tuiModel) {
      const requireIdle = () => { if (activeTask || session!.busy || workflow || closing) throw new Error('Stop active work before making this change.'); };
      const editTasks = async (changes: unknown[]) => {
        requireIdle();
        const file = await tools.call('todo_update', { revision: tuiModel!.taskRevision, changes }, { origin: 'user', writable: options.writable, confirm: async () => true }) as { tasks: TaskCard[]; revision: number };
        tuiModel!.tasks = file.tasks; tuiModel!.taskRevision = file.revision; tuiModel!.toast = 'Task saved';
      };
      tui = new TuiApp(tuiModel, {
        submit, interrupt: ctrlC, exit: () => { void close(); }, approve: (id, choice) => approvals.answer(id, String(choice + 1)),
        failure: error => { process.exitCode = 1; lineUI.notice('TUI ERROR', message(error), 'error'); void close(); },
        refresh, context: updateContext,
        readMemory: async id => { const document = await memories.read(id); return `${document.source}\n\n${document.markdown}`; },
        resumeSession: id => submit(`/resume ${id}`),
        saveMemory: async (kind, title, body) => {
          requireIdle(); const result = await memories.add(kindSchema.parse(kind), title, body, provenance());
          tuiModel!.toast = result.indexed ? `Saved ${result.source}` : result.warning ?? 'Markdown saved; index needs repair.';
          // A successful Markdown save must close the form even if a subsequent index query fails.
          await refresh('memory').catch(() => {});
        },
        addTask: (title, status) => editTasks([{ operation: 'add', title, status }]),
        updateTask: (id, status) => editTasks([{ operation: 'edit', id, status }]),
        toggleMemory: () => { session!.memory = !session!.memory; tuiModel!.toast = `Automatic recall ${session!.memory ? 'enabled' : 'disabled'}`; updateContext(); },
      });
      approvals.on('change', () => { tuiModel!.setApproval(approvals.active); updateContext(); });
      if (values.resume) await hydrate();
      updateContext(); tui.start(); await tui.closed;
    } else {
      input = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive && !!process.stdout.isTTY && !values.plain, prompt: ui.prompt() });
      input.on('SIGINT', ctrlC); input.on('line', submit);
      if (interactive) input.prompt();
      await new Promise<void>(resolveInput => input!.once('close', resolveInput));
    }
    approvals.close(); // EOF never approves anything.
    if (activeTask && !closing) await activeTask.catch(() => {});
  } finally {
    await close();
    process.removeListener('SIGINT', ctrlC); process.removeListener('SIGTERM', terminate);
  }
}

main().catch(error => { tui?.close(); lineUI.notice('ERROR', message(error), 'error'); process.exitCode = 1; });

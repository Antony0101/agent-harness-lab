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
import { projectContext } from './context.js';
import { fixWorkflow, fixtureCheck } from './workflow.js';
import { message, safeText } from './util.js';
import { TerminalUI } from './terminal.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  workspace: { type: 'string' }, write: { type: 'boolean', default: false },
  model: { type: 'string' }, prompt: { type: 'string' }, resume: { type: 'string' },
  replay: { type: 'string' }, debug: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false }, plain: { type: 'boolean', default: false },
  'no-memory': { type: 'boolean', default: false },
  'data-dir': { type: 'string' }, help: { type: 'boolean', default: false },
} });
let input: ReturnType<typeof createInterface> | undefined;
let promptState: () => 'idle' | 'running' | 'approval' = () => 'idle';
const redraw = !!process.stdin.isTTY && !!process.stdout.isTTY && !values.plain && values.prompt === undefined;
const ui = new TerminalUI(text => {
  if (input && redraw) { clearLine(process.stdout, 0); cursorTo(process.stdout, 0); }
  process.stdout.write(text);
  if (input && redraw) { input.setPrompt(ui.prompt(promptState())); input.prompt(true); }
}, {
  color: !!process.stdout.isTTY && !values.plain && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb',
  unicode: !values.plain, columns: () => process.stdout.columns || 88,
});
const write = (text: string) => ui.write(text);
const renderer = (full = false) => new EventRenderer(write, values.debug, { ui, verbose: full || values.verbose || values.debug });
const help = `Learning Harness — a small, inspectable personal Codex client

npm start -- [--workspace PATH] [--write] [--model NAME]
             [--prompt TEXT] [--resume LOCAL_ID] [--replay LOCAL_ID]
             [--no-memory] [--verbose] [--plain] [--debug] [--data-dir PATH]

Default: read-only fixtures/sample-project; ChatGPT sign-in required.
Finds Codex on PATH or in VS Code extensions; CODEX_BIN overrides discovery.
No API-key fallback.
Noninteractive input denies approval requests. --replay works offline.
Command output is compact by default. --verbose expands it; --plain disables styling.

/new                    Create a new conversation
/status                 Inspect application state and IDs
/stop                   Interrupt active work
/sessions               List saved local sessions
/resume <local-id>      Resume runtime history; never replay actions
/events [--full] [id]   Replay events; --full expands saved command output
/history                Inspect the ten most recent runtime turns
/memory [on|off]        Inspect or select bounded project notes
/fix <task>             Implement/check/repair/review the fixture (--write)
/tasks                  List workflow records for manual inspection
/approve <id> <number>  Answer the current approval with its exact ID
/help                   Show these commands
/exit                   Close child processes and exit
`;

async function main() {
  if (values.help) { write(help); return; }
  const store = new Store(values['data-dir'] ?? resolve(root, '.harness'));
  if (values.replay) {
    const history = await store.events(values.replay);
    for (const warning of history.warnings) write(`[log] ${warning}\n`);
    replay(history.events, renderer()); return;
  }
  await store.init();
  const runtime = await findCodex();
  const options = { bin: runtime.bin, workspace: resolve(values.workspace ?? resolve(root, 'fixtures/sample-project')), root, writable: values.write, model: values.model, debug: values.debug };
  const version = await runtimeVersion(options.bin);
  ui.banner(options.workspace, options.writable);
  ui.info('runtime', `${version} / ${runtime.source}`);
  if (values.debug) ui.info('executable', runtime.bin);
  try {
    const generatedVersion = (await readFile(resolve(root, 'generated/runtime-version.txt'), 'utf8')).trim();
    if (generatedVersion !== version) throw new Error(`Protocol generated for ${generatedVersion}, executable is ${version}. Run npm run protocol.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Run npm run protocol before starting the live client.');
    throw error;
  }
  const interactive = !!process.stdin.isTTY && values.prompt === undefined;
  const approvals = new Approvals(interactive, write, 120_000, ui);
  let session: Session | undefined;
  const bridge = await approvalBroker((name, args) => session?.toolApproval(name, args) ?? Promise.resolve(false));
  const rpc = createCodexRpc(options, bridge);
  promptState = () => approvals.active ? 'approval' : session?.busy ? 'running' : 'idle';
  let workflow: AbortController | undefined;
  let activeTask: Promise<unknown> | undefined;
  let closing = false;
  let cleanupPromise: Promise<void> | undefined;
  const close = () => cleanupPromise ??= (async () => {
    closing = true; session?.shutdown();
    const terminalInput = input; input = undefined;
    approvals.close(); workflow?.abort(); terminalInput?.close();
    await rpc.close(); await bridge.close();
    try { await store.flush(); } catch (error) { write(`[storage] ${message(error)}\n`); }
  })();
  const stop = async () => {
    workflow?.abort(); approvals.cancelAll();
    if (session?.busy) await session.interrupt();
  };
  let interrupting = false;
  const ctrlC = () => {
    if (closing || interrupting || (!session?.busy && !workflow)) { void close(); return; }
    interrupting = true;
    void stop().catch(error => write(`${message(error)}\n`)).finally(() => { interrupting = false; });
  };
  process.on('SIGINT', ctrlC);
  const terminate = () => { void close(); };
  process.on('SIGTERM', terminate);
  rpc.transport.on('diagnostic', (text: string) => { if (values.debug) process.stderr.write(safeText(text)); });
  try {
    const client = new CodexClient(rpc, options);
    session = new Session(client, store, approvals, renderer(), write, version);
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
    input = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive && !values.plain, prompt: ui.prompt() });
    input.on('SIGINT', ctrlC);
    function launch(task: Promise<unknown>) {
      activeTask = task;
      void task.catch(error => { process.exitCode = 1; write(`[error] ${message(error)}\n`); })
        .finally(() => {
          if (activeTask === task) activeTask = undefined;
          if (!closing && interactive && input) { input.setPrompt(ui.prompt(promptState())); input.prompt(true); }
        });
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
      if (cmd === '/status') { ui.fields('SESSION', { ...session!.snapshot(), workflow: !!workflow }); return; }
      if (cmd === '/help') { write(help); return; }
      if (cmd === '/sessions') {
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
        ui.rule(full ? 'SAVED EVENTS / FULL OUTPUT' : 'SAVED EVENTS');
        replay(history.events, renderer(full)); return;
      }
      if (cmd === '/tasks') {
        const { readdir } = await import('node:fs/promises');
        write((await readdir(resolve(store.root, 'tasks'))).filter(file => file.endsWith('.json')).join('\n') + '\n'); return;
      }
      if (activeTask || session!.busy || workflow) throw new Error('Work is active. Use /stop, /status, or answer the pending approval.');
      if (cmd === '/new') { await session!.fresh(); return; }
      if (cmd === '/resume') { await session!.resume(arg); return; }
      if (cmd === '/history') { ui.rule('RUNTIME HISTORY'); ui.body(JSON.stringify(await client.history(session!.record!.codexThreadId), null, 2)); return; }
      if (cmd === '/memory') {
        if (arg && arg !== 'on' && arg !== 'off') throw new Error('Usage: /memory [on|off]');
        if (arg) session!.memory = arg === 'on';
        const context = await projectContext(root);
        ui.fields('PROJECT MEMORY', { enabled: session!.memory, source: context?.source, characters: context?.characters, truncated: context?.truncated });
        if (context) ui.body(context.text);
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
      const result = await session!.run(line);
      if (result.status !== 'completed') process.exitCode = 1;
    }
    // Do not await agent turns in the line callback: /stop and approvals stay responsive.
    input.on('line', line => {
      if (closing) return;
      const control = /^\/(approve|stop|status|help|exit|sessions|events|tasks)(?:\s|$)/.test(line.trim()) || !line.trim();
      if (!control && (activeTask || session!.busy || workflow)) { write('Busy. Use /stop or /status.\n'); return; }
      if (control) void command(line).catch(error => write(`[error] ${message(error)}\n`));
      else launch(command(line));
    });
    if (interactive) input.prompt();
    await new Promise<void>(resolveInput => input!.once('close', resolveInput));
    approvals.close(); // EOF never approves anything.
    if (activeTask && !closing) await activeTask.catch(() => {});
  } finally {
    await close();
    process.removeListener('SIGINT', ctrlC); process.removeListener('SIGTERM', terminate);
  }
}

main().catch(error => { ui.notice('ERROR', message(error), 'error'); process.exitCode = 1; });

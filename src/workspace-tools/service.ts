import { lstat, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { assertWorkspace, readRegular, within, workspacePath } from './paths.js';
import { runProcess } from './process.js';
import { TodoStore } from './todos.js';
import { CHECK_SCRIPTS, checkSchema, emptySchema, gitSchema, LOCAL_TOOL_NAMES, searchSchema, todoUpdateSchema, type CallContext } from './types.js';
import { message } from '../util.js';

const EXCLUDED = ['node_modules', 'generated', 'dist', 'build', 'out', 'target', 'coverage', '.harness'];
type ToolEvent = { name: string; phase: 'started' | 'completed' | 'failed'; elapsedMs?: number; result?: unknown; error?: string };
function fitRecords<T>(records: T[], base: Record<string, unknown>, key: string): Record<string, unknown> {
  const result = { ...base, [key]: records };
  while (JSON.stringify(result).length > 60_000 && records.length) { records.pop(); result.truncated = true; }
  return result;
}
const globLiteral = (path: string) => path.replace(/[\\*?\[\]{}]/g, '\\$&');

export class WorkspaceTools {
  readonly todos: TodoStore;
  private controllers = new Set<AbortController>();
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  private checking = false;
  private constructor(readonly workspace: string, readonly dataDir: string,
    private observe: (event: ToolEvent) => Promise<void>, private checkTimeoutMs: number) {
    this.todos = new TodoStore(workspace, dataDir);
  }
  static async open(workspace: string, dataDir: string, options: {
    observe?: (event: ToolEvent) => Promise<void>; checkTimeoutMs?: number;
  } = {}): Promise<WorkspaceTools> {
    return new WorkspaceTools(await realpath(workspace), await realpath(dataDir), options.observe ?? (async () => {}), options.checkTimeoutMs ?? 60_000);
  }
  call(name: string, input: unknown, context: CallContext): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Workspace tools are closed'));
    const controller = new AbortController(); this.controllers.add(controller);
    const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
    const task = this.perform(name, input, { ...context, signal });
    this.pending.add(task);
    void task.finally(() => { this.controllers.delete(controller); this.pending.delete(task); }).catch(() => {});
    return task;
  }
  private async perform(name: string, input: unknown, context: CallContext): Promise<unknown> {
    const started = Date.now();
    try {
      context.signal?.throwIfAborted(); await assertWorkspace(this.workspace);
      if (!(LOCAL_TOOL_NAMES as readonly string[]).includes(name)) throw new Error(`Unsupported workspace tool: ${name}`);
      await this.observe({ name, phase: 'started' });
      let result: unknown;
      switch (name) {
        case 'workspace_search': result = await this.search(input, context.signal); break;
        case 'git_inspect': result = await this.git(input, context.signal); break;
        case 'project_check': result = await this.check(input, context); break;
        case 'todo_list': emptySchema.parse(input); result = await this.todos.list(); break;
        case 'todo_update': result = await this.todos.update(todoUpdateSchema.parse(input), (tool, details, signal) => this.authorize(tool, details, context, signal), context.signal); break;
      }
      await this.observe({ name, phase: 'completed', elapsedMs: Date.now() - started, result });
      return result;
    } catch (error) {
      await this.observe({ name, phase: 'failed', elapsedMs: Date.now() - started, error: message(error) }); throw error;
    }
  }
  private async authorize(name: string, details: unknown, context: CallContext, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if ((context.origin === 'agent' || name === 'project_check') && !context.writable) throw new Error('Restart with --write to authorize this operation');
    return context.confirm(name, details, signal);
  }
  private excluded(path: string): boolean {
    const parts = relative(this.workspace, path).split(sep);
    return parts.some(part => part.startsWith('.') || EXCLUDED.includes(part))
      || (this.dataDir !== this.workspace && within(this.workspace, this.dataDir) && within(this.dataDir, path));
  }
  private async search(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const args = searchSchema.parse(input); const target = await workspacePath(this.workspace, args.path);
    if (target !== this.workspace && this.excluded(target)) throw new Error('Search path is hidden or excluded from workspace search');
    const info = await lstat(target);
    const globs = EXCLUDED.map(name => `!**/${name}/**`);
    if (within(this.workspace, this.dataDir) && this.workspace !== this.dataDir) globs.push(`!${globLiteral(relative(this.workspace, this.dataDir).split(sep).join('/'))}/**`);
    if (this.workspace === this.dataDir) {
      for (const name of ['sessions', 'events', 'tasks', 'todos']) globs.push(`!${name}/**`);
      globs.push('!memory.sqlite*');
    }
    // Walk from the workspace root even for a requested file: positional files
    // and explicitly ignored directories otherwise bypass rg's ignore rules.
    const command = ['--no-config', '--json', '--fixed-strings', '--line-number', '--color=never', '--max-filesize=1M',
      ...globs.flatMap(glob => ['--glob', glob]), ...(args.caseInsensitive ? ['--ignore-case'] : []), '--', args.query, '.'];
    const process = await runProcess('rg', command, this.workspace, { signal, timeoutMs: 10_000, maxBytes: 256 * 1024, stopOnLimit: true });
    if (process.timedOut) throw new Error('Workspace search timed out after 10 seconds');
    if (process.code !== 0 && process.code !== 1 && !process.truncated) throw new Error(`Workspace search failed: ${process.stderr}`);
    const matches: Array<{ path: string; line: number; text: string }> = []; let truncated = process.truncated;
    const lines = process.stdout.split('\n');
    for (const [index, line] of lines.entries()) {
      if (!line) continue;
      let item;
      try { item = JSON.parse(line); } catch { if (process.truncated && index === lines.length - 1) break; throw new Error('Invalid search process output'); }
      if (item.type !== 'match') continue;
      const path = item.data.path.text as string | undefined; const text = item.data.lines.text as string | undefined;
      if (path === undefined || text === undefined) { truncated = true; continue; }
      const fullPath = resolve(this.workspace, path);
      if (!within(this.workspace, fullPath) || this.excluded(fullPath) || (info.isFile() ? fullPath !== target : !within(target, fullPath))) continue;
      // Reject paths replaced by symlinks while rg was walking.
      await workspacePath(this.workspace, relative(this.workspace, fullPath)); signal?.throwIfAborted();
      if (matches.length >= args.limit) { truncated = true; break; }
      const excerpt = text.trimEnd(); if (excerpt.length > 400) truncated = true;
      matches.push({ path: relative(this.workspace, fullPath), line: item.data.line_number, text: excerpt.slice(0, 400) });
    }
    return fitRecords(matches, { query: args.query, path: args.path, truncated, elapsedMs: process.elapsedMs }, 'matches');
  }
  private async git(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const args = gitSchema.parse(input);
    const started = Date.now();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
    const prefix = ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'color.ui=false'];
    const run = (argv: string[]) => runProcess('git', [...prefix, ...argv], this.workspace, { signal, env, timeoutMs: Math.max(1, 10_000 - (Date.now() - started)), maxBytes: 256 * 1024, stopOnLimit: true });
    const root = await run(['rev-parse', '--show-toplevel']);
    if (root.timedOut) throw new Error('Git inspection timed out after 10 seconds');
    if (root.code !== 0) throw new Error('Selected workspace is not inside a Git working tree');
    const repository = await realpath(root.stdout.replace(/\r?\n$/, ''));
    if (!within(repository, this.workspace)) throw new Error('Git working tree does not contain the selected workspace');
    const argv = args.operation === 'status' ? ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']
      : args.operation === 'diff' ? ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--relative', ...(args.staged ? ['--cached'] : []), '--', '.']
        : ['log', '--no-show-signature', `-${args.limit}`, '--format=%H%x00%aI%x00%s%x00', '--', '.'];
    const result = await run(argv);
    if (result.timedOut) throw new Error('Git inspection timed out after 10 seconds');
    if (result.code !== 0 && !result.truncated) {
      if (args.operation === 'log' && /does not have any commits|unknown revision|bad default revision/i.test(result.stderr)) return { operation: 'log', commits: [], truncated: false, elapsedMs: result.elapsedMs };
      throw new Error(`Git inspection failed: ${result.stderr}`);
    }
    const base = { operation: args.operation, workspace: this.workspace, truncated: result.truncated, elapsedMs: result.elapsedMs };
    if (args.operation === 'diff') {
      let diff = result.stdout; let truncated = result.truncated;
      while (JSON.stringify(diff).length > 55_000) { diff = diff.slice(0, Math.floor(diff.length / 2)); truncated = true; }
      return { ...base, staged: args.staged, diff, truncated };
    }
    if (args.operation === 'log') {
      const parts = result.stdout.split('\0'); const commits = [];
      for (let i = 0; i + 2 < parts.length; i += 3) commits.push({ id: parts[i].trim(), at: parts[i + 1], subject: parts[i + 2] });
      return fitRecords(commits, base, 'commits');
    }
    const parts = result.stdout.split('\0'); const entries = [];
    for (let i = 0; i < parts.length - 1; i++) {
      const status = parts[i].slice(0, 2); const path = resolve(repository, parts[i].slice(3));
      let from: string | undefined;
      if (/[RC]/.test(status) && i + 1 < parts.length - 1) {
        const original = resolve(repository, parts[++i]); if (within(this.workspace, original)) from = relative(this.workspace, original);
      }
      if (within(this.workspace, path)) entries.push({ path: relative(this.workspace, path), status, ...(from ? { from } : {}) });
    }
    return fitRecords(entries, base, 'entries');
  }
  private async scripts() {
    const path = await workspacePath(this.workspace, 'package.json');
    const source = await readRegular(path); const value = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object in workspace package.json');
    const scripts: Record<string, string> = {};
    for (const name of CHECK_SCRIPTS) if (typeof value.scripts?.[name] === 'string' && value.scripts[name].trim()) scripts[name] = value.scripts[name];
    return { source, scripts, all: value.scripts as Record<string, unknown> | undefined };
  }
  private async check(input: unknown, context: CallContext): Promise<unknown> {
    const args = checkSchema.parse(input);
    if (!args.script) {
      try { return { scripts: (await this.scripts()).scripts }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { scripts: {}, message: 'No package.json in this workspace' }; throw error; }
    }
    if (this.checking) throw new Error('A project check is already active');
    this.checking = true;
    try {
      const selected = await this.scripts(); const script = args.script;
      if (!Object.hasOwn(selected.scripts, script)) throw new Error(`No permitted npm script '${script}'. Available: ${Object.keys(selected.scripts).join(', ') || 'none'}`);
      const details = { workspace: this.workspace, executable: 'npm', args: ['run', script], script: selected.scripts[script],
        pre: typeof selected.all?.[`pre${script}`] === 'string' ? selected.all[`pre${script}`] : null,
        post: typeof selected.all?.[`post${script}`] === 'string' ? selected.all[`post${script}`] : null, timeoutMs: this.checkTimeoutMs };
      if (!await this.authorize('project_check', details, context, context.signal)) throw new Error('Project check denied by application policy');
      context.signal?.throwIfAborted();
      if ((await this.scripts()).source !== selected.source) throw new Error('package.json changed during approval; submit a new project_check request');
      context.signal?.throwIfAborted();
      const result = await runProcess('npm', ['run', script], this.workspace, { signal: context.signal, timeoutMs: this.checkTimeoutMs, maxBytes: 20_000 });
      let output = result.output; let truncated = result.truncated;
      while (JSON.stringify(output).length > 55_000) { output = output.slice(0, Math.floor(output.length / 2)); truncated = true; }
      return { script, code: result.code, passed: result.code === 0 && !result.timedOut, elapsedMs: result.elapsedMs, output, timedOut: result.timedOut, truncated };
    } finally { this.checking = false; }
  }
  cancelAll(): void { for (const controller of this.controllers) controller.abort(); }
  async close(): Promise<void> { this.closed = true; this.cancelAll(); await Promise.allSettled([...this.pending]); }
}

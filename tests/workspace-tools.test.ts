import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { WorkspaceTools } from '../src/workspace-tools/service.js';
import { runProcess } from '../src/workspace-tools/process.js';
import { workspaceRegistry } from '../src/tools/workspace.js';
import { Registry } from '../src/tools/registry.js';
import { emptySchema, type CallContext, type TodoFile } from '../src/workspace-tools/types.js';
import { temporary, waitFor } from './helpers.js';

const execute = promisify(execFile);
const user: CallContext = { origin: 'user', writable: true, confirm: async () => true };
const agent: CallContext = { origin: 'agent', writable: true, confirm: async () => false };
async function setup(checkTimeoutMs?: number) {
  const env = await temporary(); const service = await WorkspaceTools.open(env.root, env.store.root, { checkTimeoutMs });
  return { ...env, service, call: (name: string, args: unknown = {}, context = user) => service.call(name, args, context),
    cleanup: async () => { await service.close(); await env.cleanup(); } };
}
const git = (cwd: string, ...args: string[]) => execute('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
async function init(cwd: string) { await git(cwd, 'init', '-q'); await git(cwd, 'config', 'user.name', 'Synthetic Test'); await git(cwd, 'config', 'user.email', 'test@example.invalid'); }
async function scripts(root: string, value: Record<string, string>) { await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, scripts: value })); }
const node = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;

test('workspace search is literal, bounded, case-aware, and respects ignore rules and exclusions', async t => {
  const env = await setup(); t.after(env.cleanup); await init(env.root);
  await writeFile(join(env.root, '.gitignore'), 'ignored.txt\nignored-folder/\n');
  const needle = 'Literal [a+b]*';
  await writeFile(join(env.root, 'visible.txt'), `${needle}\n${needle.toUpperCase()}\n${needle}\n`);
  for (const name of ['ignored.txt', '.hidden', 'binary.bin']) await writeFile(join(env.root, name), (name === 'binary.bin' ? '\0' : '') + needle);
  for (const folder of ['ignored-folder', '.hidden-folder', 'node_modules', 'generated', 'dist', 'build', 'out', 'target', 'coverage']) {
    await mkdir(join(env.root, folder)); await writeFile(join(env.root, folder, 'secret.txt'), needle);
  }
  await writeFile(join(env.store.root, 'private.txt'), needle);
  const found = await env.call('workspace_search', { query: needle }) as { matches: Array<{ path: string; line: number }>; truncated: boolean };
  assert.deepEqual(found.matches.map(x => [x.path, x.line]), [['visible.txt', 1], ['visible.txt', 2], ['visible.txt', 3]]);
  const limited = await env.call('workspace_search', { query: needle, limit: 1 }) as typeof found;
  assert.equal(limited.matches.length, 1); assert.equal(limited.truncated, true);
  assert.equal(((await env.call('workspace_search', { query: needle, caseInsensitive: false })) as typeof found).matches.length, 2);
  assert.equal(((await env.call('workspace_search', { query: needle, path: 'ignored.txt' })) as typeof found).matches.length, 0);
  assert.equal(((await env.call('workspace_search', { query: needle, path: 'ignored-folder' })) as typeof found).matches.length, 0);
  assert.equal(((await env.call('workspace_search', { query: 'no-matches-anywhere' })) as typeof found).matches.length, 0);
  await assert.rejects(env.call('workspace_search', { query: needle, path: '.hidden' }), /hidden|excluded/);
  await assert.rejects(env.call('workspace_search', { query: needle, limit: 101 }));
});

test('search restricts paths, rejects symlinks/traversal, and excludes a custom data directory', async t => {
  const env = await setup(); t.after(env.cleanup);
  await mkdir(join(env.root, 'source')); await mkdir(join(env.root, 'other'));
  await writeFile(join(env.root, 'source', 'inside.txt'), 'mango content'); await writeFile(join(env.root, 'other', 'outside.txt'), 'mango content');
  await symlink(join(env.root, 'other'), join(env.root, 'linked')); await symlink(join(env.root, 'other', 'outside.txt'), join(env.root, 'linked-file.txt'));
  const result = await env.call('workspace_search', { query: 'mango', path: 'source' }) as { matches: Array<{ path: string }> };
  assert.deepEqual(result.matches.map(x => x.path), ['source/inside.txt']);
  for (const path of ['../elsewhere', '/etc/passwd', 'source/../other', 'linked', 'linked-file.txt']) await assert.rejects(env.call('workspace_search', { query: 'mango', path }));
  const all = await env.call('workspace_search', { query: 'mango' }) as typeof result;
  assert.ok(all.matches.every(x => !x.path.startsWith('linked')));
  const data = join(env.root, 'records'); await mkdir(data); await writeFile(join(data, 'private.txt'), 'papaya hidden data');
  const custom = await WorkspaceTools.open(env.root, data);
  try {
    assert.deepEqual((await custom.call('workspace_search', { query: 'papaya' }, user) as typeof result).matches, []);
    await assert.rejects(custom.call('workspace_search', { query: 'papaya', path: 'records' }, user), /excluded/);
  } finally { await custom.close(); }
});

test('Git status, staged/unstaged diff, and history stay inside a workspace subtree without changing the index', async t => {
  const env = await temporary(); await init(env.root);
  const app = join(env.root, 'app'); const other = join(env.root, 'other'); await mkdir(app); await mkdir(other);
  await writeFile(join(app, 'code.txt'), 'initial\n'); await writeFile(join(other, 'private.txt'), 'outside-original\n');
  await git(env.root, 'add', 'app', 'other'); await git(env.root, 'commit', '-qm', 'Initial workspace commit');
  await writeFile(join(other, 'private.txt'), 'outside-commit-secret\n'); await git(env.root, 'add', 'other'); await git(env.root, 'commit', '-qm', 'Outside-only commit');
  await writeFile(join(app, 'code.txt'), 'staged-content\n'); await git(env.root, 'add', 'app'); await writeFile(join(app, 'code.txt'), 'unstaged-content\n');
  await writeFile(join(other, 'private.txt'), 'outside-dirty-secret\n'); await writeFile(join(app, 'space name.txt'), 'new\n');
  const service = await WorkspaceTools.open(app, env.store.root); t.after(async () => { await service.close(); await env.cleanup(); });
  const before = await readFile(join(env.root, '.git', 'index'));
  const status = await service.call('git_inspect', { operation: 'status' }, user) as { entries: Array<{ path: string }> };
  assert.deepEqual(status.entries.map(x => x.path).sort(), ['code.txt', 'space name.txt']);
  const diff = await service.call('git_inspect', { operation: 'diff' }, user) as { diff: string };
  assert.match(diff.diff, /unstaged-content/); assert.doesNotMatch(diff.diff, /outside|app\/code/);
  assert.match(JSON.stringify(await service.call('git_inspect', { operation: 'diff', staged: true }, user)), /staged-content/);
  const log = await service.call('git_inspect', { operation: 'log', limit: 1 }, user) as { commits: Array<{ subject: string }> };
  assert.deepEqual(log.commits.map(x => x.subject), ['Initial workspace commit']);
  assert.deepEqual(await readFile(join(env.root, '.git', 'index')), before);
  await assert.rejects(service.call('git_inspect', { operation: 'reset' }, user));
  await assert.rejects(service.call('git_inspect', { operation: 'status', staged: true }, user));
});

test('Git works at repository roots, handles an empty history, and disables external diff helpers', async t => {
  const env = await setup(); t.after(env.cleanup);
  await assert.rejects(env.call('git_inspect', { operation: 'status' }), /not inside a Git/);
  await init(env.root);
  assert.deepEqual((await env.call('git_inspect', { operation: 'log' }) as { commits: unknown[] }).commits, []);
  await writeFile(join(env.root, 'tracked.txt'), 'before\n'); await git(env.root, 'add', 'tracked.txt'); await git(env.root, 'commit', '-qm', 'First');
  const marker = join(env.root, 'helper-ran'); const helper = join(env.root, 'helper.cjs');
  await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`);
  await git(env.root, 'config', 'diff.external', `${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`);
  await git(env.root, 'config', 'core.fsmonitor', `${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`);
  await writeFile(join(env.root, 'tracked.txt'), 'after\n');
  assert.match(JSON.stringify(await env.call('git_inspect', { operation: 'diff' })), /after/);
  await env.call('git_inspect', { operation: 'status' }); await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('task batches persist across restart, share canonical identity, and isolate workspaces', async t => {
  const env = await setup(); let reopened: WorkspaceTools | undefined; let other: WorkspaceTools | undefined;
  t.after(async () => { await reopened?.close(); await other?.close(); await env.cleanup(); });
  const first = await env.call('todo_list') as TodoFile; assert.equal(first.revision, 0);
  const added = await env.call('todo_update', { revision: 0, changes: [{ operation: 'add', title: 'Learn schemas' }, { operation: 'add', title: 'Learn approvals', status: 'in_progress' }] }) as TodoFile;
  assert.equal(added.revision, 1); assert.equal(added.tasks[0].status, 'pending');
  assert.match(added.tasks[0].id, /^[a-f0-9-]{36}$/);
  const edited = await env.call('todo_update', { revision: 1, changes: [
    { operation: 'edit', id: added.tasks[0].id, title: 'Schemas learned', status: 'completed' }, { operation: 'remove', id: added.tasks[1].id },
  ] }) as TodoFile;
  assert.equal(edited.tasks.length, 1); assert.equal(edited.tasks[0].status, 'completed');
  await env.service.close();
  const alias = join(env.root, 'alias'); await symlink(env.root, alias);
  reopened = await WorkspaceTools.open(alias, env.store.root);
  assert.deepEqual(await reopened.call('todo_list', {}, user), edited);
  const second = join(env.root, 'second'); await mkdir(second); other = await WorkspaceTools.open(second, env.store.root);
  assert.deepEqual((await other.call('todo_list', {}, user) as TodoFile).tasks, []);
  assert.notEqual(other.todos.path, reopened.todos.path);
});

test('invalid batches and stale revisions are atomic; corrupt and symlinked task files are preserved', async t => {
  const env = await setup(); t.after(env.cleanup);
  const saved = await env.call('todo_update', { revision: 0, changes: [{ operation: 'add', title: 'Existing' }] }) as TodoFile;
  const before = await readFile(env.service.todos.path, 'utf8');
  await assert.rejects(env.call('todo_update', { revision: 0, changes: [{ operation: 'add', title: 'Stale' }] }), /stale/);
  await assert.rejects(env.call('todo_update', { revision: 1, changes: [{ operation: 'add', title: 'Partial' }, { operation: 'remove', id: randomUUID() }] }), /Unknown task/);
  await assert.rejects(env.call('todo_update', { revision: 1, changes: [{ operation: 'edit', id: saved.tasks[0].id }] }));
  assert.equal(await readFile(env.service.todos.path, 'utf8'), before);
  await writeFile(env.service.todos.path, '{broken');
  await assert.rejects(env.call('todo_list'), /preserved/);
  await assert.rejects(env.call('todo_update', { revision: 1, changes: [{ operation: 'add', title: 'Overwrite' }] }), /preserved/);
  assert.equal(await readFile(env.service.todos.path, 'utf8'), '{broken');
  const original = env.service.todos.path + '.original'; await rename(env.service.todos.path, original); await symlink(original, env.service.todos.path);
  await assert.rejects(env.call('todo_list')); assert.equal(await readFile(original, 'utf8'), '{broken');
});

test('task approval shows the complete batch and denial/cancellation leave no task file', async t => {
  const env = await setup(); t.after(env.cleanup); const changes = [{ operation: 'add', title: 'Proposed learning' }];
  let proposal: unknown;
  await assert.rejects(env.call('todo_update', { revision: 0, changes }, { ...agent, confirm: async (_name, details) => { proposal = details; return false; } }), /denied/);
  assert.match(JSON.stringify(proposal), /Proposed learning/); assert.match(JSON.stringify(proposal), /destination/);
  await assert.rejects(stat(env.service.todos.path), { code: 'ENOENT' });
  const controller = new AbortController();
  await assert.rejects(env.call('todo_update', { revision: 0, changes }, { ...agent, signal: controller.signal, confirm: async () => { controller.abort(); return true; } }));
  await assert.rejects(stat(env.service.todos.path), { code: 'ENOENT' });
  await assert.rejects(env.call('todo_update', { revision: 0, changes }, { ...agent, writable: false, confirm: async () => true }), /--write/);
  // A direct user command may update metadata without --write or another prompt.
  assert.equal((await env.call('todo_update', { revision: 0, changes }, { ...user, writable: false }) as TodoFile).revision, 1);
});

test('external edits during task approval are preserved and a later operation can recover', async t => {
  const env = await setup(); t.after(env.cleanup);
  const added = await env.call('todo_update', { revision: 0, changes: [{ operation: 'add', title: 'Original' }] }) as TodoFile;
  await assert.rejects(env.call('todo_update', { revision: 1, changes: [{ operation: 'remove', id: added.tasks[0].id }] }, {
    ...agent, confirm: async () => { added.tasks[0].title = 'External edit'; await writeFile(env.service.todos.path, JSON.stringify(added)); return true; },
  }), /changed during approval/);
  assert.equal((await env.call('todo_list') as TodoFile).tasks[0].title, 'External edit');
  assert.equal((await env.call('todo_update', { revision: 1, changes: [{ operation: 'edit', id: added.tasks[0].id, status: 'completed' }] }) as TodoFile).revision, 2);
});

test('task limits bound storage while complete large lists remain valid JSON', async t => {
  const env = await setup(); t.after(env.cleanup); let revision = 0;
  for (let batch = 0; batch < 5; batch++) {
    const result = await env.call('todo_update', { revision, changes: Array.from({ length: 20 }, () => ({ operation: 'add', title: '"'.repeat(200) })) }) as TodoFile;
    revision = result.revision;
  }
  const registry = workspaceRegistry((name, args) => env.call(name, args));
  const result = await registry.call('todo_list', {});
  assert.equal(result.isError, undefined); assert.equal(JSON.parse(result.content[0].text).tasks.length, 100);
  await assert.rejects(env.call('todo_update', { revision, changes: [{ operation: 'add', title: 'Over capacity' }] }));
  assert.equal((await env.call('todo_list') as TodoFile).revision, revision);
});

test('project checks discover only allowed scripts and run normal npm hooks with inspected definitions', async t => {
  const env = await setup(); t.after(env.cleanup);
  assert.deepEqual(await env.call('project_check'), { scripts: {}, message: 'No package.json in this workspace' });
  await scripts(env.root, { pretest: node('console.log("PRE-HOOK")'), test: node('console.log("TEST-BODY")'), posttest: node('console.log("POST-HOOK")'), deploy: node('process.exit(9)') });
  assert.deepEqual(Object.keys((await env.call('project_check') as { scripts: object }).scripts), ['test']);
  let proposal: unknown;
  const result = await env.call('project_check', { script: 'test' }, { ...agent, confirm: async (_name, details) => { proposal = details; return true; } }) as { passed: boolean; code: number; output: string; elapsedMs: number };
  assert.equal(result.passed, true); assert.equal(result.code, 0); assert.ok(result.elapsedMs >= 0);
  assert.match(result.output, /PRE-HOOK[\s\S]*TEST-BODY[\s\S]*POST-HOOK/);
  const details = proposal as { workspace: string; args: string[]; pre: string; post: string; timeoutMs: number };
  assert.equal(details.workspace, env.root); assert.deepEqual(details.args, ['run', 'test']);
  assert.match(details.pre, /PRE-HOOK/); assert.match(details.post, /POST-HOOK/); assert.equal(details.timeoutMs, 60000);
  await assert.rejects(env.call('project_check', { script: 'deploy' }));
  await assert.rejects(env.call('project_check', { script: 'lint' }), /No permitted/);
  await assert.rejects(env.call('project_check', { script: 'test', command: 'anything' }));
});

test('denied, read-only, cancelled, and changed check proposals spawn nothing', async t => {
  const env = await setup(); t.after(env.cleanup);
  const marker = join(env.root, 'ran.txt'); const script = node(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`);
  await scripts(env.root, { test: script });
  await assert.rejects(env.call('project_check', { script: 'test' }, agent), /denied/);
  await assert.rejects(env.call('project_check', { script: 'test' }, { ...user, writable: false }), /--write/);
  const controller = new AbortController();
  await assert.rejects(env.call('project_check', { script: 'test' }, { ...agent, signal: controller.signal, confirm: async () => { controller.abort(); return true; } }));
  await assert.rejects(env.call('project_check', { script: 'test' }, { ...agent, confirm: async () => { await scripts(env.root, { test: script, pretest: node('console.log("Changed hook")') }); return true; } }), /changed during approval/);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('project checks report failures, truncate output as valid JSON, and reject concurrent checks', async t => {
  const env = await setup(); t.after(env.cleanup);
  await scripts(env.root, { test: node('console.log("x".repeat(100000)); process.exit(3)') });
  const registry = workspaceRegistry((name, args) => env.call(name, args));
  const result = await registry.call('project_check', { script: 'test' });
  const data = JSON.parse(result.content[0].text);
  assert.equal(result.isError, undefined); assert.equal(data.code, 3); assert.equal(data.passed, false); assert.equal(data.truncated, true);
  let resolveApproval!: (allow: boolean) => void; let waiting = false;
  const pending = env.call('project_check', { script: 'test' }, { ...agent, confirm: () => { waiting = true; return new Promise(resolve => { resolveApproval = resolve; }); } });
  await waitFor(() => waiting);
  await assert.rejects(env.call('project_check', { script: 'test' }), /already active/);
  resolveApproval(false); await assert.rejects(pending, /denied/);
});

test('process timeouts and cancellation terminate subprocess groups and leave the service usable', async t => {
  const env = await setup(100); t.after(env.cleanup);
  await scripts(env.root, { test: node('setInterval(()=>{},1000)') });
  const result = await env.call('project_check', { script: 'test' }) as { timedOut: boolean; passed: boolean };
  assert.equal(result.timedOut, true); assert.equal(result.passed, false);
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], env.root, { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /cancelled/);
  const direct = await runProcess(process.execPath, ['-e', 'console.log("recovered")'], env.root);
  assert.match(direct.stdout, /recovered/);
});

test('cancellation kills a descendant that ignores SIGTERM before returning', async t => {
  const env = await setup(); t.after(env.cleanup);
  const ready = join(env.root, 'descendant-ready'); const finished = join(env.root, 'descendant-finished');
  const descendant = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(ready)},'ready'); setTimeout(()=>fs.writeFileSync(${JSON.stringify(finished)},'unexpected'),2500);`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});`;
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', parent], env.root, { signal: controller.signal }); void pending.catch(() => {});
  await waitFor(() => existsSync(ready)); const started = Date.now(); controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.ok(Date.now() - started < 2000, 'must terminate descendants instead of waiting for their delayed exit');
  assert.equal(existsSync(finished), false);
});

test('missing executables affect only their tool and oversized registry results stay structured', async t => {
  const env = await setup(); t.after(env.cleanup); const original = process.env.PATH;
  try {
    process.env.PATH = '/nonexistent';
    await assert.rejects(env.call('workspace_search', { query: 'test' }), /Install rg/);
    await assert.rejects(env.call('git_inspect', { operation: 'status' }), /Install git/);
    await scripts(env.root, { test: 'echo harmless' });
    await assert.rejects(env.call('project_check', { script: 'test' }), /Install npm/);
    assert.deepEqual((await env.call('todo_list') as TodoFile).tasks, []);
  } finally { if (original === undefined) delete process.env.PATH; else process.env.PATH = original; }
  const registry = new Registry().add({ name: 'large', description: 'Synthetic', effect: 'read', schema: emptySchema,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: async () => ({ huge: '"'.repeat(20000) }) });
  const result = await registry.call('large', {}); assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).truncated, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { chmod, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { temporary, waitFor } from './helpers.js';

const fake = resolve('fixtures/protocol/fake-codex.mjs');
const execute = promisify(execFile);
async function cli(args: string[]) {
  return execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(), env: { ...process.env, CODEX_BIN: fake }, timeout: 15_000,
  });
}

test('complete CLI uses synthetic runtime, persists, resumes, and replays offline', async t => {
  const env = await temporary(); t.after(env.cleanup); await chmod(fake, 0o755);
  const args = ['--data-dir', env.store.root, '--no-memory'];
  const first = await cli([...args, '--prompt', 'synthetic task']);
  assert.match(first.stdout, /Simulated result/); assert.match(first.stdout, /Turn completed/);
  assert.doesNotMatch(first.stdout, /disconnected/);
  const id = (await readdir(join(env.store.root, 'sessions')))[0].slice(0, -5);
  const record = JSON.parse(await readFile(join(env.store.root, 'sessions', id + '.json'), 'utf8'));
  assert.equal(record.lastKnownStatus, 'idle');
  const resumed = await cli([...args, '--resume', id, '--prompt', 'next task']); assert.match(resumed.stdout, /resumed/);
  const offline = await execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--data-dir', env.store.root, '--replay', id], { env: { ...process.env, CODEX_BIN: '/nonexistent' }, timeout: 5000 });
  assert.match(offline.stdout, /Simulated result/);
});
test('one-shot noninteractive CLI declines runtime approvals', async t => {
  const env = await temporary(); t.after(env.cleanup); await chmod(fake, 0o755);
  const result = await cli(['--data-dir', env.store.root, '--no-memory', '--prompt', '[approval]']);
  assert.match(result.stdout, /Action declined/); assert.doesNotMatch(result.stdout, /Action approved/);
});
test('CLI remains responsive to stop while a turn runs', async t => {
  const env = await temporary(); t.after(env.cleanup); await chmod(fake, 0o755);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--data-dir', env.store.root, '--no-memory'], { env: { ...process.env, CODEX_BIN: fake }, stdio: 'pipe' });
  let output = ''; let stopped = false;
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000); t.after(() => clearTimeout(timeout));
  child.stdout.on('data', chunk => {
    output += chunk.toString();
    if (!stopped && output.includes('WORKING')) { stopped = true; child.stdin.write('/stop\n'); }
    if (output.includes('Turn interrupted')) child.stdin.end();
  });
  child.stdin.write('[slow]\n');
  await new Promise<void>((resolveDone, reject) => { child.once('error', reject); child.once('close', () => resolveDone()); });
  assert.equal(stopped, true); assert.match(output, /Turn interrupted/); assert.doesNotMatch(output, /Simulated result/);
});

test('offline memory CLI supports explicit saves, import, retrieval, rebuild, and removal without Codex', async t => {
  const env = await temporary(); t.after(env.cleanup);
  const offline = (command: string) => execute(process.execPath, ['--import', 'tsx', 'src/cli.ts',
    '--workspace', env.root, '--data-dir', env.store.root, '--plain', '--memory', command],
  { env: { ...process.env, CODEX_BIN: '/nonexistent' }, timeout: 15_000 });
  const added = await offline('add facts Apricot convention :: Apricot arrays sum to zero.');
  assert.match(added.stdout, /MEMORY SAVED/);
  const id = `facts/${(await readdir(join(env.root, 'memory', 'facts')))[0]}`;
  assert.match((await offline('search apricot')).stdout, /Apricot arrays sum to zero/);
  assert.match((await offline(`read ${id}`)).stdout, /harness-memory/);
  assert.match((await offline('list facts')).stdout, /Apricot convention/);
  const legacy = join(env.root, 'notes', 'legacy.md'); await writeFile(legacy, '# Kiwi knowledge\n\nKiwi uses local files.');
  await offline(`import lessons "${legacy}"`);
  assert.match((await offline('search kiwi')).stdout, /Kiwi uses local files/);
  await unlink(join(env.store.root, 'memory.sqlite'));
  assert.match((await offline('rebuild')).stdout, /2 Markdown files/);
  assert.match((await offline('search apricot')).stdout, /Apricot/);
  assert.match((await offline('')).stdout, /automaticRecall/);
  assert.match((await offline('forget ' + id)).stdout, /MEMORY REMOVED/);
  assert.match((await offline('search apricot')).stdout, /0 MATCHES/);
});

test('all five workspace tools work through the offline CLI without Codex', async t => {
  const env = await temporary(); t.after(env.cleanup);
  const args = ['--import', 'tsx', 'src/cli.ts', '--workspace', env.root, '--data-dir', env.store.root, '--plain'];
  const offline = (extra: string[]) => execute(process.execPath, [...args, ...extra], { env: { ...process.env, CODEX_BIN: '/nonexistent' }, timeout: 15_000 });
  const list = await offline(['--tools']);
  for (const name of ['workspace_search', 'git_inspect', 'project_check', 'todo_list', 'todo_update']) assert.ok(list.stdout.includes(name));
  await writeFile(join(env.root, 'source.txt'), 'Peach convention');
  assert.match((await offline(['--tool', 'workspace_search', '--args', '{"query":"peach"}'])).stdout, /Peach convention/);
  await execute('git', ['init', '-q'], { cwd: env.root });
  assert.match((await offline(['--tool', 'git_inspect', '--args', '{"operation":"status"}'])).stdout, /source.txt/);
  await offline(['--tool', 'todo_update', '--args', '{"revision":0,"changes":[{"operation":"add","title":"Learn tools"}]}']);
  assert.match((await offline(['--tool', 'todo_list'])).stdout, /Learn tools/);
  const file = (await readdir(join(env.store.root, 'todos')))[0];
  const saved = JSON.parse(await readFile(join(env.store.root, 'todos', file), 'utf8'));
  await offline(['--tool', 'todo_update', '--args', JSON.stringify({ revision: 1, changes: [{ operation: 'edit', id: saved.tasks[0].id, status: 'completed' }] })]);
  assert.match((await offline(['--tool', 'todo_list'])).stdout, /completed/);
  await writeFile(join(env.root, 'package.json'), JSON.stringify({ scripts: { typecheck: `${JSON.stringify(process.execPath)} -e "console.log('OFFLINE-CHECK')"` } }));
  assert.match((await offline(['--tool', 'project_check'])).stdout, /typecheck/);
  await assert.rejects(offline(['--tool', 'project_check', '--args', '{"script":"typecheck"}']), (error: unknown) => {
    assert.match((error as { stdout: string }).stdout, /--write/); return true;
  });
  assert.match((await offline(['--write', '--tool', 'project_check', '--args', '{"script":"typecheck"}'])).stdout, /OFFLINE-CHECK/);
  const events = (await readdir(join(env.store.root, 'events'))).filter(name => name.startsWith('tools-'));
  assert.ok(events.length > 0); assert.match(await readFile(join(env.store.root, 'events', events[0]), 'utf8'), /tool\/(started|completed)/);
  assert.match((await offline(['--replay', events[0].slice(0, -6)])).stdout, /Tool/);
  for (const extra of [['--tools', '--prompt', 'ignored'], ['--tool', 'todo_list', '--memory', 'list'], ['--args', '{}']]) {
    await assert.rejects(offline(extra), (error: unknown) => { assert.match((error as { stdout: string }).stdout, /Choose one mode|requires --tool/); return true; });
  }
});

test('direct terminal tools remain responsive to status and stop during an npm check', async t => {
  const env = await temporary(); t.after(env.cleanup);
  const marker = join(env.root, 'check-started'); const done = join(env.root, 'check-finished');
  const code = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)},'ready'); setTimeout(()=>fs.writeFileSync(${JSON.stringify(done)},'bad'),3000);`;
  await writeFile(join(env.root, 'package.json'), JSON.stringify({ scripts: { test: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}` } }));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--workspace', env.root, '--data-dir', env.store.root, '--write', '--plain', '--no-memory'],
    { env: { ...process.env, CODEX_BIN: fake }, stdio: 'pipe' });
  let output = ''; child.stdout.on('data', chunk => { output += chunk.toString(); });
  const closed = new Promise<number | null>((resolveDone, reject) => { child.once('error', reject); child.once('close', resolveDone); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  child.stdin.write('/tool project_check {"script":"test"}\n');
  await waitFor(() => existsSync(marker));
  child.stdin.write('/status\n/stop\n'); await waitFor(() => output.includes('cancelled'));
  child.stdin.end(); await closed;
  assert.match(output, /directTool\s+true/); assert.equal(existsSync(done), false);
});

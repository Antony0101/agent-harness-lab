import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { chmod, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { temporary } from './helpers.js';

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

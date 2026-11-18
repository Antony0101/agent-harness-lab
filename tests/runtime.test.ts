import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { findCodex } from '../src/runtime.js';
import { temporary } from './helpers.js';

async function binary(path: string, mode = 0o755) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, mode);
  return path;
}

test('explicit CODEX_BIN wins and a bad override fails instead of silently falling back', async t => {
  const env = await temporary(); t.after(env.cleanup);
  const chosen = await binary(join(env.root, 'chosen codex'));
  await binary(join(env.root, 'path', 'codex'));
  const options = { home: env.root, cwd: env.root, platform: 'linux' as const, arch: 'x64' };
  assert.deepEqual(await findCodex({ ...options, env: { CODEX_BIN: chosen, PATH: join(env.root, 'path') } }), { bin: chosen, source: 'CODEX_BIN' });
  assert.deepEqual(await findCodex({ ...options, env: { CODEX_BIN: `./${relative(env.root, chosen)}`, PATH: '' } }), { bin: chosen, source: 'CODEX_BIN' });
  await assert.rejects(findCodex({ ...options, env: { CODEX_BIN: '/missing-codex', PATH: join(env.root, 'path') } }), /Correct it or unset CODEX_BIN/);
});

test('PATH takes precedence over editor discovery and skips non-executable entries', async t => {
  const env = await temporary(); t.after(env.cleanup);
  await binary(join(env.root, 'first', 'codex'), 0o644);
  const chosen = await binary(join(env.root, 'second', 'codex'));
  await binary(join(env.root, '.vscode-server/extensions/openai.chatgpt-99.0/bin/linux-x86_64/codex'));
  assert.deepEqual(await findCodex({ home: env.root, cwd: env.root, platform: 'linux', arch: 'x64', env: { PATH: `${join(env.root, 'first')}:${join(env.root, 'second')}` } }), { bin: chosen, source: 'PATH' });
});

test('WSL terminal without Codex on PATH discovers newest compatible editor runtime', async t => {
  const env = await temporary(); t.after(env.cleanup);
  const folder = join(env.root, '.vscode-server/extensions');
  await binary(join(folder, 'openai.chatgpt-2.9-linux-x64/bin/linux-x86_64/codex'));
  const chosen = await binary(join(folder, 'openai.chatgpt-2.10-linux-x64/bin/linux-x86_64/codex'));
  await binary(join(folder, 'openai.chatgpt-3.0-linux-arm64/bin/linux-aarch64/codex'));
  await binary(join(folder, 'unrelated-extension/bin/linux-x86_64/codex'));
  assert.deepEqual(await findCodex({ home: env.root, cwd: env.root, platform: 'linux', arch: 'x64', env: { PATH: '/missing' } }), { bin: chosen, source: 'editor extension' });
});

test('desktop and ARM editor layouts are discovered without a version-specific path', async t => {
  const env = await temporary(); t.after(env.cleanup);
  const chosen = await binary(join(env.root, '.vscode/extensions/openai.chatgpt-1.0/bin/darwin-aarch64/codex'));
  assert.deepEqual(await findCodex({ home: env.root, cwd: env.root, platform: 'darwin', arch: 'arm64', env: { PATH: '/missing' } }), { bin: chosen, source: 'editor extension' });
});

test('missing runtime provides installation and override instructions', async t => {
  const env = await temporary(); t.after(env.cleanup);
  await assert.rejects(findCodex({ home: env.root, cwd: env.root, env: { PATH: '/missing' } }), /npm install -g @openai\/codex/);
});

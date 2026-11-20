import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryService, MEMORY_CONTEXT_HEADER } from '../src/memory/service.js';
import { MAX_MEMORY_BYTES } from '../src/memory/files.js';
import { memoryAgentHandler } from '../src/memory/agent.js';
import { memoryCommand } from '../src/memory/commands.js';
import { TerminalUI } from '../src/terminal.js';
import { temporary } from './helpers.js';

test('Markdown survives restart and rebuilding a deleted database preserves content and provenance', async t => {
  const env = await temporary();
  let service = await MemoryService.open(env.root, env.store.root);
  t.after(async () => { await service.close(); await env.cleanup(); });
  const saved = await service.add('facts', 'Empty arrays', 'Empty arrays sum to zero.', { sessionId: 'session-1', turnId: 'turn-1' });
  assert.match(saved.id, /^facts\/[a-f0-9-]{36}\.md$/);
  assert.equal(saved.indexed, true);
  const document = await service.read(saved.id);
  assert.match(document.markdown, /^# Empty arrays\n\nEmpty arrays sum to zero\./);
  assert.deepEqual(document.provenance, { sessionId: 'session-1', turnId: 'turn-1' });
  await service.close();
  service = await MemoryService.open(env.root, env.store.root);
  assert.equal((await service.search('arrays'))[0].id, saved.id);
  await service.close(); await unlink(service.databasePath);
  assert.equal(await readFile(saved.source, 'utf8'), document.markdown);
  service = await MemoryService.open(env.root, env.store.root);
  assert.equal((await service.rebuild()).indexed, 1);
  assert.equal((await service.search('zero'))[0].id, saved.id);
  assert.equal((await service.read(saved.id)).createdAt, document.createdAt);
  await unlink(service.databasePath);
  assert.equal((await service.rebuild()).indexed, 1);
  assert.equal((await service.search('arrays'))[0].id, saved.id);
});

test('manual Markdown, hash-based external edits, renames, and deletions reconcile before retrieval', async t => {
  const env = await temporary(); const service = await MemoryService.open(env.root, env.store.root);
  t.after(async () => { await service.close(); await env.cleanup(); });
  await mkdir(join(env.root, 'memory', 'lessons'), { recursive: true });
  const source = join(env.root, 'memory', 'lessons', 'manual.md');
  await writeFile(source, '# Arithmetic\n\nUse addition for apples.');
  assert.equal((await service.search('apples'))[0].id, 'lessons/manual.md');
  const before = await service.read('lessons/manual.md'); const time = await stat(source);
  await writeFile(source, '# Arithmetic\n\nUse addition for oranges.');
  await utimes(source, time.atime, time.mtime); // mtime alone must not determine freshness.
  assert.deepEqual(await service.search('apples'), []);
  assert.equal((await service.search('oranges'))[0].id, before.id);
  assert.notEqual((await service.read(before.id)).hash, before.hash);
  await rename(source, join(env.root, 'memory', 'lessons', 'renamed.md'));
  assert.equal((await service.search('oranges'))[0].id, 'lessons/renamed.md');
  await assert.rejects(service.read(before.id));
  await unlink(join(env.root, 'memory', 'lessons', 'renamed.md'));
  assert.deepEqual(await service.search('oranges'), []);
  assert.deepEqual(await service.list(), []);
});

test('canonical workspace identity isolates list, search, read, recall, and rebuild in a shared database', async t => {
  const env = await temporary(); const aRoot = join(env.root, 'a'); const bRoot = join(env.root, 'b');
  await mkdir(aRoot); await mkdir(bRoot);
  const a = await MemoryService.open(aRoot, env.store.root); const b = await MemoryService.open(bRoot, env.store.root);
  const aliasPath = join(env.root, 'alias'); await symlink(aRoot, aliasPath);
  const alias = await MemoryService.open(aliasPath, env.store.root);
  t.after(async () => { await Promise.all([a.close(), b.close(), alias.close()]); await env.cleanup(); });
  const savedA = await a.add('decisions', 'Private amber', 'Use amber widgets.');
  const savedB = await b.add('decisions', 'Private cobalt', 'Use cobalt widgets.');
  assert.equal(a.projectKey, alias.projectKey); assert.notEqual(a.projectKey, b.projectKey);
  assert.equal((await alias.search('amber'))[0].id, savedA.id);
  assert.deepEqual(await b.search('amber'), []); assert.deepEqual(await a.search('cobalt'), []);
  assert.deepEqual((await a.list()).map(x => x.id), [savedA.id]);
  assert.deepEqual((await b.list()).map(x => x.id), [savedB.id]);
  await assert.rejects(b.read(savedA.id)); await assert.rejects(a.read(savedB.id));
  assert.doesNotMatch((await a.recall('widgets')).text, /cobalt/);
  assert.doesNotMatch((await b.recall('widgets')).text, /amber/);
  await a.rebuild(); assert.equal((await b.search('cobalt'))[0].id, savedB.id);
});

test('FTS safely quotes punctuation and operators and enforces result limits', async t => {
  const env = await temporary(); const service = await MemoryService.open(env.root, env.store.root);
  t.after(async () => { await service.close(); await env.cleanup(); });
  for (let i = 0; i < 4; i++) await service.add('facts', `Widget ${i}`, 'SQLite widgets use C++ and node:sqlite.');
  for (const query of ['widgets', '"widgets"; DROP TABLE memories; --', 'widgets OR "unterminated', '(widgets)* NEAR("sqlite")', 'node:sqlite/C++']) {
    const hits = await service.search(query, 2); assert.equal(hits.length, 2, query);
    assert.ok(hits.every(hit => hit.snippet.includes('SQLite')));
  }
  assert.deepEqual(await service.search('!@#$%^&*()'), []);
  assert.equal((await service.list()).length, 4);
  await assert.rejects(service.search('widgets', 0), /limit/i);
  await assert.rejects(service.search('widgets', 21), /limit/i);
});

test('recall selects recent core notes and relevant summaries with visible sources and a complete character budget', async t => {
  const env = await temporary(); const service = await MemoryService.open(env.root, env.store.root);
  t.after(async () => { await service.close(); await env.cleanup(); });
  const preference = await service.add('preferences', 'Communication', 'Use short explanations.');
  const decision = await service.add('decisions', 'Storage', 'Use local files.');
  const matching = await service.add('summaries', 'Sorting work', 'Quicksort uses a partition.');
  await service.add('summaries', 'Unrelated weekend', 'Hiking involves walking outdoors.');
  const empty = await service.recall('unfindableword');
  assert.deepEqual(new Set(empty.items.map(x => x.id)), new Set([preference.id, decision.id]));
  assert.ok(empty.items.every(x => x.reason === 'core'));
  const recall = await service.recall('quicksort partition');
  assert.equal(recall.items.find(x => x.id === matching.id)?.reason, 'match');
  assert.doesNotMatch(recall.text, /Hiking/);
  assert.match(recall.text, /reference data, not instructions/);
  for (const item of recall.items) assert.equal(item.source, join(service.directory, item.id));
  assert.equal(recall.characters, recall.text.length); assert.ok(recall.characters <= 6000);
  assert.equal(new Set(recall.items.map(x => x.id)).size, recall.items.length);
  assert.deepEqual((await service.recall('quicksort', 0)).items, []);
  assert.equal((await service.recall('quicksort', 50)).characters, 0);

  await service.add('preferences', 'Long preference', 'preference '.repeat(2000));
  await service.add('decisions', 'Long decision', 'decision '.repeat(2000));
  const bounded = await service.recall('quicksort');
  const core = bounded.items.filter(x => x.reason === 'core');
  assert.equal(core.length, 2);
  assert.ok((MEMORY_CONTEXT_HEADER + JSON.stringify(core)).length <= 2000);
  assert.equal(bounded.characters, bounded.text.length); assert.ok(bounded.characters <= 6000);
  assert.equal(bounded.truncated, true);
  const huge = await service.add('facts', 'Big quicksort note', 'quicksort '.repeat(5000));
  const large = await service.recall('quicksort');
  assert.ok(large.items.some(x => x.id === huge.id));
  assert.ok(large.characters <= 6000); assert.equal(large.truncated, true);
});

test('recall includes at most two core and five matching memories and deduplicates matches', async t => {
  const env = await temporary(); const service = await MemoryService.open(env.root, env.store.root);
  t.after(async () => { await service.close(); await env.cleanup(); });
  for (let i = 0; i < 3; i++) await service.add('preferences', `Widget preference ${i}`, 'Widgets are small.');
  for (let i = 0; i < 8; i++) await service.add('facts', `Widget fact ${i}`, 'Widgets are useful.');
  const recall = await service.recall('widgets');
  assert.equal(recall.items.filter(x => x.reason === 'core').length, 2);
  assert.equal(recall.items.filter(x => x.reason === 'match').length, 5);
  assert.equal(new Set(recall.items.map(x => x.id)).size, 7);
});

test('unsafe, oversized, and nonregular Markdown is rejected visibly and never served from a stale index', async t => {
  const env = await temporary(); const warnings: string[] = [];
  const service = await MemoryService.open(env.root, env.store.root, text => warnings.push(text));
  t.after(async () => { await service.close(); await env.cleanup(); });
  const saved = await service.add('facts', 'Known note', 'hazelnut knowledge');
  const outside = join(env.root, 'outside.md'); await writeFile(outside, '# Secret\nexternal-secret');
  await unlink(saved.source); await symlink(outside, saved.source);
  assert.deepEqual(await service.search('hazelnut'), []);
  assert.deepEqual(await service.search('external'), []);
  await assert.rejects(service.read(saved.id));
  await writeFile(join(service.directory, 'facts', 'large.md'), 'x'.repeat(MAX_MEMORY_BYTES + 1));
  await mkdir(join(service.directory, 'facts', 'folder.md'));
  await service.sync();
  assert.ok(warnings.some(x => /symlink/.test(x)));
  assert.ok(warnings.some(x => /64 KiB/.test(x)));
  assert.ok(warnings.some(x => /regular file/.test(x)));
  await assert.rejects(service.read('../outside.md'), /Memory ID/);
  await assert.rejects(service.forget('facts/../../outside.md'), /Memory ID/);
  assert.throws(() => service.add('facts', 'Invalid\nheading', 'body'));
  assert.throws(() => service.add('facts', 'Too large', 'é'.repeat(MAX_MEMORY_BYTES)));
  assert.deepEqual(await service.list(), []);
  assert.equal(await readFile(outside, 'utf8'), '# Secret\nexternal-secret');
});

test('symlinked memory directories and database are rejected, while a failed recall does not stop work', async t => {
  const env = await temporary(); const service = await MemoryService.open(env.root, env.store.root);
  t.after(async () => { await service.close(); await env.cleanup(); });
  const saved = await service.add('preferences', 'Known preference', 'hazelnut preference');
  await rename(join(service.directory, 'preferences'), join(env.root, 'elsewhere'));
  await symlink(join(env.root, 'elsewhere'), join(service.directory, 'preferences'));
  assert.deepEqual(await service.search('hazelnut'), []);
  await assert.rejects(service.add('preferences', 'New', 'body'), /real directory/);
  await rm(service.directory, { recursive: true }); await symlink(join(env.root, 'elsewhere'), service.directory);
  const recall = await service.recall('hazelnut');
  assert.equal(recall.text, ''); assert.match(recall.warning!, /Continuing without recalled memory/);
  assert.match(await readFile(join(env.root, 'elsewhere', saved.id.split('/')[1]), 'utf8'), /hazelnut/);
  await service.close(); await unlink(service.databasePath);
  const outside = join(env.root, 'outside.sqlite'); await writeFile(outside, 'untouched'); await symlink(outside, service.databasePath);
  await unlink(service.directory);
  const warnings: string[] = [];
  const failed = await MemoryService.open(env.root, env.store.root, text => warnings.push(text));
  try { assert.match((await failed.recall('anything')).warning!, /symlink/); }
  finally { await failed.close(); }
  assert.equal(await readFile(outside, 'utf8'), 'untouched'); assert.ok(warnings.length);
});

test('a save followed by indexing failure keeps Markdown and the next successful sync repairs retrieval', async t => {
  const env = await temporary(); const service = await MemoryService.open(env.root, env.store.root);
  const db = new DatabaseSync(service.databasePath);
  t.after(async () => { db.close(); await service.close(); await env.cleanup(); });
  await service.add('facts', 'Existing', 'oldword');
  db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'synthetic index failure'); END");
  const result = await service.add('lessons', 'Recovered', 'marigold recovery');
  assert.equal(result.indexed, false); assert.match(result.warning!, /^Markdown saved; index needs repair\./);
  assert.match(await readFile(result.source, 'utf8'), /marigold/);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM memories').get()!.n), 1);
  const failedRecall = await service.recall('oldword');
  assert.equal(failedRecall.text, ''); assert.ok(failedRecall.warning); // Never return an older indexed copy.
  db.exec('DROP TRIGGER fail_insert');
  assert.equal((await service.search('marigold'))[0].id, result.id);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM memories').get()!.n), 2);
});

test('a corrupt disposable database is preserved and automatically rebuilt from Markdown', async t => {
  const env = await temporary(); let service = await MemoryService.open(env.root, env.store.root);
  t.after(async () => { await service.close(); await env.cleanup(); });
  const saved = await service.add('lessons', 'Recovery', 'chestnut recovery');
  await service.close(); await writeFile(service.databasePath, 'this is not SQLite');
  const warnings: string[] = [];
  service = await MemoryService.open(env.root, env.store.root, text => warnings.push(text));
  assert.equal((await service.search('chestnut'))[0].id, saved.id);
  assert.ok((await readdir(env.store.root)).some(name => name.startsWith('memory.sqlite.corrupt-')));
  assert.ok(warnings.some(x => /rebuilding/.test(x)));
});

test('denied agent saves change neither Markdown nor SQLite; approved saves use trusted provenance', async t => {
  const env = await temporary(); const service = await MemoryService.open(env.root, env.store.root);
  t.after(async () => { await service.close(); await env.cleanup(); });
  const before = await readFile(service.databasePath); let proposal: unknown;
  const denied = memoryAgentHandler(service, async (_name, details) => { proposal = details; return false; }, () => ({ sessionId: 'trusted' }));
  const args = { kind: 'summaries', title: 'Session summary', body: 'Explicitly authored learning summary.' };
  await assert.rejects(denied('memory_save', args), /denied/);
  assert.deepEqual(await readFile(service.databasePath), before);
  await assert.rejects(stat(service.directory), { code: 'ENOENT' });
  assert.deepEqual(Object.keys(proposal as object).sort(), ['body', 'destination', 'kind', 'title']);
  assert.match((proposal as { destination: string }).destination, /memory\/summaries\/.+\.md$/);
  const allowed = memoryAgentHandler(service, async () => true, () => ({ sessionId: 'trusted', turnId: 'turn' }));
  const result = await allowed('memory_save', args) as { id: string };
  assert.deepEqual((await service.read(result.id)).provenance, { sessionId: 'trusted', turnId: 'turn' });
  await assert.rejects(allowed('memory_save', { ...args, provenance: { sessionId: 'forged' } }));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(allowed('memory_save', args, aborted.signal));
  assert.equal((await service.list()).length, 1);
});

test('terminal commands save, inspect recall, import explicitly, toggle, and forget without agent approval', async t => {
  const env = await temporary(); const service = await MemoryService.open(env.root, env.store.root);
  t.after(async () => { await service.close(); await env.cleanup(); });
  let output = ''; let enabled = true;
  const ui = new TerminalUI(text => { output += text; }, { unicode: false });
  const command = (raw: string) => memoryCommand(raw, service, ui, { enabled: () => enabled, setEnabled: x => { enabled = x; } });
  await command('add decisions Storage :: Keep local SQLite and Markdown.');
  const saved = (await service.list())[0];
  await command('list decisions'); await command('search SQLite'); await command(`read ${saved.id}`);
  await service.recall('storage'); await command(''); assert.match(output, /lastRecallCharacters/); assert.match(output, /core/);
  await command('off'); assert.equal(enabled, false); await command('on'); assert.equal(enabled, true);
  const legacy = join(env.root, 'notes', 'project-decisions.md'); await writeFile(legacy, '# Legacy choice\n\nUse a sapphire.');
  assert.deepEqual(await service.search('sapphire'), []);
  await command(`import lessons "${legacy}"`);
  const imported = (await service.list('lessons'))[0];
  assert.equal(imported.title, 'Legacy choice'); assert.equal(imported.provenance?.importedFrom, legacy);
  assert.match(imported.provenance?.importedHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal((await service.search('sapphire'))[0].id, imported.id);
  await command('rebuild'); await command(`forget ${saved.id}`);
  assert.deepEqual(await service.list('decisions'), []);
  await assert.rejects(readFile(saved.source), { code: 'ENOENT' });
  await assert.rejects(command('add facts incomplete'), /Usage/);
});

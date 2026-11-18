import test from 'node:test';
import assert from 'node:assert/strict';
import { fixWorkflow, runCheck, fixtureCheck, type CheckResult } from '../src/workflow.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary } from './helpers.js';

const pass: CheckResult = { passed: true, code: 0, timedOut: false, output: 'passed' };
const fail: CheckResult = { passed: false, code: 1, timedOut: false, output: 'independent assertion failed' };

test('workflow verifies outcomes rather than trusting a success message and caps repair at one', async t => {
  const env = await temporary(); t.after(env.cleanup); const prompts: string[] = [];
  const task = await fixWorkflow({ task: 'fix', sessionId: 's1', store: env.store,
    run: async prompt => { prompts.push(prompt); return { id: `t${prompts.length}`, status: 'completed', text: 'Everything passed!' }; },
    check: async () => fail });
  assert.equal(task.stage, 'failed'); assert.equal(task.attempts, 2); assert.equal(prompts.length, 2);
  assert.match(prompts[1], /independent assertion failed/); assert.equal(task.checks.length, 2);
});
test('workflow performs implementation, repair if needed, review, and final check', async t => {
  const env = await temporary(); t.after(env.cleanup); let calls = 0; let checks = 0;
  const task = await fixWorkflow({ task: 'fix', sessionId: 's1', store: env.store,
    run: async () => ({ id: `t${++calls}`, status: 'completed', text: '' }),
    check: async () => ++checks === 1 ? fail : pass });
  assert.equal(task.stage, 'completed'); assert.equal(calls, 3); assert.equal(checks, 3);
});
test('failed or interrupted agent turns stop the workflow without starting checks', async t => {
  const env = await temporary(); t.after(env.cleanup); let checks = 0;
  const task = await fixWorkflow({ task: 'fix', sessionId: 's1', store: env.store,
    run: async () => ({ id: 't', status: 'interrupted', text: '' }), check: async () => { checks++; return pass; } });
  assert.equal(task.stage, 'unknown'); assert.equal(checks, 0); assert.match(task.error!, /no next stage/);
});
test('workflow cancellation between turns cannot schedule another action', async t => {
  const env = await temporary(); t.after(env.cleanup); const controller = new AbortController(); let calls = 0;
  const task = await fixWorkflow({ task: 'fix', sessionId: 's1', store: env.store, signal: controller.signal,
    run: async () => { calls++; controller.abort(); return { id: 't', status: 'completed', text: '' }; }, check: async () => pass });
  assert.equal(task.stage, 'interrupted'); assert.equal(calls, 1);
});
test('review cannot override a failing final independent check', async t => {
  const env = await temporary(); t.after(env.cleanup); let checks = 0;
  const task = await fixWorkflow({ task: 'fix', sessionId: 's1', store: env.store,
    run: async () => ({ id: 't', status: 'completed', text: '' }), check: async () => ++checks === 1 ? pass : fail });
  assert.equal(task.stage, 'failed'); assert.equal(task.attempts, 1);
});
test('fixed checks run without a shell and time out hung processes', async () => {
  const result = await runCheck(process.execPath, ['-e', 'console.log(process.argv[1])', 'literal; exit 1'], process.cwd());
  assert.equal(result.passed, true); assert.match(result.output, /literal; exit 1/);
  const timeout = await runCheck(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), 30);
  assert.equal(timeout.timedOut, true); assert.equal(timeout.passed, false);
});

test('the fixture acceptance program is frozen before the agent can modify it', async t => {
  const env = await temporary(); t.after(env.cleanup);
  const fixture = join(env.root, 'fixtures/sample-project'); await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, 'sum.mjs'), 'export const sum = () => 1;');
  await writeFile(join(fixture, 'check.mjs'), "import assert from 'node:assert/strict'; import { sum } from './sum.mjs'; assert.equal(sum([]),0);");
  const check = fixtureCheck(env.root, fixture);
  await writeFile(join(fixture, 'check.mjs'), 'console.log("forged pass")');
  assert.equal((await check()).passed, false);
  await writeFile(join(fixture, 'sum.mjs'), 'export const sum = () => 0;');
  assert.equal((await check()).passed, true);
});

test('complete offline workflow changes actual fixture files and independently verifies them', async t => {
  const env = await temporary(); t.after(env.cleanup);
  const fixture = join(env.root, 'fixtures/sample-project'); await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, 'sum.mjs'), 'export const sum = values => values.reduce((a,b)=>a+b,1);');
  await writeFile(join(fixture, 'check.mjs'), "import assert from 'node:assert/strict'; import { sum } from './sum.mjs'; assert.equal(sum([]),0); assert.equal(sum([1,2]),3); assert.equal(sum([-1,1]),0);");
  const check = fixtureCheck(env.root, fixture); assert.equal((await check()).passed, false);
  let turns = 0;
  const task = await fixWorkflow({ task: 'Fix sum', sessionId: 'offline-session', store: env.store, check,
    run: async prompt => {
      turns++;
      if (prompt.startsWith('Implement')) await writeFile(join(fixture, 'sum.mjs'), 'export const sum = values => values.reduce((a,b)=>a+b,0);');
      return { id: `offline-turn-${turns}`, status: 'completed', text: 'Scripted teaching agent; no inference' };
    } });
  assert.equal(task.stage, 'completed'); assert.equal(turns, 2);
  assert.equal(task.checks.length, 2); assert.ok(task.checks.every(result => result.passed));
  const saved = JSON.parse(await readFile(join(env.store.root, 'tasks', task.id + '.json'), 'utf8'));
  assert.equal(saved.stage, 'completed'); assert.equal(saved.attempts, 1);
});

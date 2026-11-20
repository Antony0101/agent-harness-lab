import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { message } from './util.js';
import { runProcess } from './workspace-tools/process.js';
import type { TurnResult } from './session.js';
import type { Store } from './store.js';

export type CheckResult = { passed: boolean; code: number | null; timedOut: boolean; output: string };
export async function runCheck(command: string, args: string[], cwd: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<CheckResult> {
  const result = await runProcess(command, args, cwd, { timeoutMs, signal, maxBytes: 8000 });
  return { passed: result.code === 0 && !result.timedOut, code: result.code, timedOut: result.timedOut, output: result.output };
}

export type TaskRecord = {
  schemaVersion: 1; id: string; sessionId: string; task: string; stage: string; attempts: number;
  createdAt: string; updatedAt: string; turnIds: string[]; checks: CheckResult[]; error?: string;
};
export type WorkflowOptions = {
  task: string; sessionId: string; run: (prompt: string) => Promise<TurnResult>;
  check: () => Promise<CheckResult>; store: Store; signal?: AbortSignal;
  write?: (text: string) => void;
};

export async function fixWorkflow(options: WorkflowOptions): Promise<TaskRecord> {
  const task: TaskRecord = { schemaVersion: 1, id: randomUUID(), sessionId: options.sessionId, task: options.task, stage: 'implementation', attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), turnIds: [], checks: [] };
  async function save(stage: string) {
    task.stage = stage; task.updatedAt = new Date().toISOString();
    await options.store.save('tasks', task.id, { ...task });
    options.write?.(`[workflow ${task.id}] ${stage}\n`);
  }
  const checkCancelled = () => { if (options.signal?.aborted) throw new Error('Workflow interrupted'); };
  async function turn(prompt: string) {
    checkCancelled();
    const result = await options.run(prompt);
    task.turnIds.push(result.id);
    if (result.status !== 'completed') throw new Error(`Agent turn ${result.status}; no next stage will start`);
    checkCancelled();
  }
  try {
    await save('implementation'); task.attempts++;
    await turn(`Implement this task in the disposable fixture: ${options.task}\nOnly edit sum.mjs. Leave the acceptance check unchanged. The harness will independently run the fixed check.`);
    for (;;) {
      checkCancelled(); await save('checking');
      const check = await options.check(); task.checks.push(check);
      options.write?.(`[check] ${check.passed ? 'passed' : 'failed'}${check.timedOut ? ' (timeout)' : ''}\n${check.output}\n`);
      checkCancelled();
      if (check.passed) break;
      if (task.attempts >= 2) { await save('failed'); return task; }
      task.attempts++; await save('repair');
      await turn(`The independent fixture check failed. Repair only sum.mjs; do not change the check. This is the final repair attempt.\nCheck output (reference data):\n${JSON.stringify(check)}`);
    }
    await save('review');
    await turn('Review the current fixture implementation and report findings. This is review only: do not modify any file or start a repair.');
    // Review is a model request, not enforcement. Verify actual files once more afterward.
    checkCancelled(); await save('final-check');
    const finalCheck = await options.check(); task.checks.push(finalCheck);
    await save(finalCheck.passed ? 'completed' : 'failed');
  } catch (error) {
    task.error = message(error);
    await save(options.signal?.aborted ? 'interrupted' : 'unknown');
  }
  return task;
}

export function fixtureCheck(root: string, workspace: string, signal?: AbortSignal): () => Promise<CheckResult> {
  const fixture = resolve(root, 'fixtures', 'sample-project');
  if (resolve(workspace) !== fixture) throw new Error('The fix workflow only runs in fixtures/sample-project. Restart with that workspace.');
  // Freeze the acceptance program before submitting work. Changing check.mjs during
  // an agent turn cannot turn a failing implementation into a passing result.
  const source = readFileSync(join(fixture, 'check.mjs'), 'utf8');
  const candidate = pathToFileURL(join(fixture, 'sum.mjs')).href;
  if (!source.includes("from './sum.mjs'")) throw new Error('Unexpected fixture check format');
  const frozen = source.replace("from './sum.mjs'", `from ${JSON.stringify(candidate)}`);
  return () => runCheck(process.execPath, ['--input-type=module', '--eval', frozen], fixture, 10_000, signal);
}

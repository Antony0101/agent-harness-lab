import { spawn } from 'node:child_process';
import { killGroup } from '../util.js';

export type ProcessResult = {
  code: number | null; stdout: string; stderr: string; output: string; timedOut: boolean; truncated: boolean; elapsedMs: number;
};
export async function runProcess(command: string, args: string[], cwd: string, options: {
  timeoutMs?: number; signal?: AbortSignal; maxBytes?: number; stopOnLimit?: boolean; env?: NodeJS.ProcessEnv;
} = {}): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  const started = Date.now();
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env: options.env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; const combined: Buffer[] = [];
    let size = 0; let timedOut = false; let truncated = false; let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined; let terminating = false;
    const terminate = () => {
      if (terminating) return; terminating = true;
      killGroup(child.pid, 'SIGTERM');
      // Keep this timer even if the group leader exits before its descendants.
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 500);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      const available = Math.max(0, (options.maxBytes ?? 64 * 1024) - size);
      const part = Buffer.from(chunk.subarray(0, available));
      if (part.length) { target.push(part); combined.push(part); size += part.length; }
      if (chunk.length > available) { truncated = true; if (options.stopOnLimit) terminate(); }
    };
    child.stdout.on('data', chunk => collect(stdout, chunk)); child.stderr.on('data', chunk => collect(stderr, chunk));
    const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs ?? 10_000);
    const abort = () => terminate();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on('error', error => { failure = error; });
    child.on('close', async code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      // A terminated parent can leave background descendants. Finish escalation
      // before reporting cancellation or letting another check start.
      if (killTimer) { await new Promise(resolve => setTimeout(resolve, 510)); clearTimeout(killTimer); }
      if (options.signal?.aborted) { reject(new Error('Tool operation cancelled')); return; }
      if (failure) {
        reject((failure as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(`Cannot execute ${command}. Install ${command} and make it available on PATH.`) : failure);
        return;
      }
      resolveResult({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        output: Buffer.concat(combined).toString('utf8'), timedOut, truncated, elapsedMs: Date.now() - started });
    });
  });
}

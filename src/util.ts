import { stripVTControlCharacters } from 'node:util';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

export function string(value: unknown, name = 'value'): string {
  if (typeof value !== 'string' || !value) throw new Error(`Expected a nonempty string: ${name}`);
  return value;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(process.platform === 'win32' ? pid : -pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

export function safeText(text: string): string {
  // Tool and model output must not send terminal control sequences.
  const withoutOsc = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '');
  return stripVTControlCharacters(withoutOsc).replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

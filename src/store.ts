import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { object, string } from './util.js';

export type AppStatus = 'idle' | 'running' | 'waitingForApproval' | 'interrupting' | 'disconnected' | 'unknown';
export type SessionRecord = {
  schemaVersion: 1; id: string; codexThreadId: string; workspace: string;
  runtimeVersion: string; createdAt: string; updatedAt: string; lastKnownStatus: AppStatus;
};
export type EventRecord = {
  schemaVersion: 1; sequence: number; at: string; direction: 'in' | 'out' | 'local';
  method: string; threadId?: string; turnId?: string; payload: unknown;
};

function validId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid local record ID');
  return id;
}

// Preserve message structure, limit large fields, and never persist credentials.
export function bounded(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[depth limit]';
  if (typeof value === 'string') return value.length > 8000 ? value.slice(0, 8000) + '\n[truncated]' : value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => bounded(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, val]) => [
    key, /token|secret|password|authorization|api.?key|email/i.test(key) ? '[redacted]' : bounded(val, depth + 1),
  ]));
  return value;
}

export class Store {
  readonly root: string;
  private tail: Promise<void> = Promise.resolve();
  private sequence = new Map<string, number>();
  private initializedLogs = new Set<string>();
  constructor(root: string) { this.root = resolve(root); }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn);
    // A disk failure stops subsequent writes rather than hiding partial history.
    this.tail = task.then(() => undefined);
    void this.tail.catch(() => {});
    return task;
  }
  async init(): Promise<void> {
    for (const folder of ['sessions', 'events', 'tasks']) await mkdir(join(this.root, folder), { recursive: true, mode: 0o700 });
  }
  private path(folder: string, id: string, extension = 'json') { return join(this.root, folder, `${validId(id)}.${extension}`); }
  async save(folder: 'sessions' | 'tasks', id: string, record: unknown): Promise<void> {
    return this.enqueue(async () => {
      const target = this.path(folder, id);
      const temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, target);
    });
  }
  async session(id: string): Promise<SessionRecord> {
    let data: Record<string, unknown>;
    try { data = object(JSON.parse(await readFile(this.path('sessions', id), 'utf8'))); }
    catch (error) { throw new Error(`Cannot read session ${id}: ${error instanceof Error ? error.message : error}`); }
    if (data.schemaVersion !== 1 || data.id !== id) throw new Error(`Invalid or unsupported session record ${id}`);
    for (const key of ['codexThreadId', 'workspace', 'runtimeVersion', 'createdAt', 'updatedAt']) string(data[key], key);
    if (!['idle', 'running', 'waitingForApproval', 'interrupting', 'disconnected', 'unknown'].includes(String(data.lastKnownStatus))) throw new Error('Invalid session status');
    return data as SessionRecord;
  }
  async sessions(): Promise<Array<SessionRecord | { id: string; error: string }>> {
    const files = await readdir(join(this.root, 'sessions'));
    return Promise.all(files.filter(file => file.endsWith('.json')).sort().map(async file => {
      const id = file.slice(0, -5);
      try { return await this.session(id); } catch (error) { return { id, error: String(error) }; }
    }));
  }
  async append(id: string, entry: Omit<EventRecord, 'schemaVersion' | 'sequence' | 'at'>): Promise<void> {
    return this.enqueue(async () => {
      const target = this.path('events', id, 'jsonl');
      if (!this.initializedLogs.has(id)) {
        let previous = '';
        try { previous = await readFile(target, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const parsed = parseEvents(previous);
        this.sequence.set(id, parsed.events.at(-1)?.sequence ?? 0);
        // Keep the original incomplete fragment as evidence and make room for a new line.
        if (previous && !previous.endsWith('\n')) await appendFile(target, '\n');
        this.initializedLogs.add(id);
      }
      const sequence = (this.sequence.get(id) ?? 0) + 1;
      const record = { schemaVersion: 1, sequence, at: new Date().toISOString(), ...entry, payload: bounded(entry.payload) };
      await appendFile(target, JSON.stringify(record) + '\n', { mode: 0o600 });
      this.sequence.set(id, sequence);
    });
  }
  async events(id: string): Promise<ReturnType<typeof parseEvents>> {
    try { return parseEvents(await readFile(this.path('events', id, 'jsonl'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], warnings: [] }; throw error; }
  }
  flush(): Promise<void> { return this.tail; }
}

export function parseEvents(content: string): { events: EventRecord[]; warnings: string[] } {
  const events: EventRecord[] = [];
  const warnings: string[] = [];
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const value = object(JSON.parse(line));
      if (value.schemaVersion !== 1 || !Number.isInteger(value.sequence) || !['in', 'out', 'local'].includes(String(value.direction)) || !('payload' in value)) throw new Error('Invalid event record');
      events.push(value as EventRecord);
    } catch { warnings.push(`Skipped damaged event line ${index + 1}`); }
  }
  return { events, warnings };
}

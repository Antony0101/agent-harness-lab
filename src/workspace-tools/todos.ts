import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readRegular, workspaceKey } from './paths.js';
import { todoFileSchema, todoUpdateSchema, type Confirm, type TodoFile, type TodoUpdate } from './types.js';

export class TodoStore {
  readonly path: string;
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly workspace: string, readonly dataDir: string) { this.path = join(dataDir, 'todos', `${workspaceKey(workspace)}.json`); }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation); this.tail = result.then(() => {}, () => {}); return result;
  }
  private async source(): Promise<string | undefined> {
    if (await realpath(this.dataDir) !== this.dataDir) throw new Error('Task storage directory changed; reopen the harness');
    try {
      const folder = await lstat(join(this.dataDir, 'todos'));
      if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('Task storage must be a real directory');
      return await readRegular(this.path, 256 * 1024);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  private parse(source: string | undefined): TodoFile {
    if (source === undefined) return { schemaVersion: 1, workspace: this.workspace, revision: 0, tasks: [] };
    try {
      const file = todoFileSchema.parse(JSON.parse(source));
      if (file.workspace !== this.workspace || new Set(file.tasks.map(task => task.id)).size !== file.tasks.length) throw new Error('Workspace mismatch or duplicate task IDs');
      return file;
    } catch { throw new Error(`Task file is invalid; preserved at ${this.path}. Repair it before updating tasks.`); }
  }
  list(): Promise<TodoFile> { return this.enqueue(async () => this.parse(await this.source())); }
  update(input: TodoUpdate, confirm: Confirm, signal?: AbortSignal): Promise<TodoFile> {
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      const args = todoUpdateSchema.parse(input); const source = await this.source(); const previous = this.parse(source);
      if (args.revision !== previous.revision) throw new Error('Task revision is stale; call todo_list and retry with its revision');
      const next = structuredClone(previous); const changes: unknown[] = []; const now = new Date().toISOString();
      for (const change of args.changes) {
        if (change.operation === 'add') {
          const task = { id: randomUUID(), title: change.title, status: change.status, createdAt: now, updatedAt: now };
          next.tasks.push(task); changes.push({ operation: 'add', after: task });
        } else {
          const index = next.tasks.findIndex(task => task.id === change.id);
          if (index < 0) throw new Error(`Unknown task ID: ${change.id}`);
          const before = { ...next.tasks[index] };
          if (change.operation === 'remove') { next.tasks.splice(index, 1); changes.push({ operation: 'remove', before }); }
          else {
            const task = { ...before, ...(change.title !== undefined ? { title: change.title } : {}), ...(change.status !== undefined ? { status: change.status } : {}), updatedAt: now };
            next.tasks[index] = task; changes.push({ operation: 'edit', before, after: task });
          }
        }
      }
      next.revision++; todoFileSchema.parse(next);
      if (!await confirm('todo_update', { workspace: this.workspace, destination: this.path, revision: previous.revision, changes }, signal)) throw new Error('Task update denied by application policy');
      signal?.throwIfAborted();
      if (await this.source() !== source) throw new Error('Task file changed during approval; call todo_list and submit a new batch');
      const folder = join(this.dataDir, 'todos'); await mkdir(folder, { recursive: true, mode: 0o700 });
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Task storage must be a real directory');
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(JSON.stringify(next, null, 2) + '\n'); await file.close();
        signal?.throwIfAborted(); await rename(temporary, this.path);
      } finally {
        await file.close(); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      }
      return next;
    });
  }
}

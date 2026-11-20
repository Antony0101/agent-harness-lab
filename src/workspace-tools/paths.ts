import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const workspaceKey = (workspace: string) => createHash('sha256').update(workspace).digest('hex');
export function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
}
export async function assertWorkspace(workspace: string): Promise<void> {
  if (await realpath(workspace) !== workspace || !(await lstat(workspace)).isDirectory()) throw new Error('Workspace changed; reopen the harness');
}
export async function workspacePath(workspace: string, input: string): Promise<string> {
  await assertWorkspace(workspace);
  if (isAbsolute(input) || input.includes('\0') || input.split(/[\\/]/).includes('..')) throw new Error('Use a relative path inside the workspace');
  const path = resolve(workspace, input);
  if (!within(workspace, path)) throw new Error('Path escapes the workspace');
  let current = workspace;
  for (const part of relative(workspace, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Workspace tool paths must not contain symlinks');
  }
  const info = await lstat(path);
  if (!info.isDirectory() && !info.isFile()) throw new Error('Expected a regular file or directory');
  return path;
}
export async function readRegular(path: string, maxBytes = 1024 * 1024): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error(`Expected a regular file no larger than ${maxBytes} bytes: ${path}`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('File grew beyond its size limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}

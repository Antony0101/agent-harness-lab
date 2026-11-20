import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MEMORY_KINDS, kindSchema, saveMemorySchema, type MemoryDocument, type MemoryKind, type MemoryProvenance } from './types.js';

export const MAX_MEMORY_BYTES = 64 * 1024;
const metadataPattern = /\n?<!-- harness-memory: ([^\n]*) -->\s*$/;
export const contentHash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export type MemoryDraft = { id: string; source: string; markdown: string };

export function memoryId(id: string): { kind: MemoryKind; filename: string } {
  const match = /^(facts|decisions|preferences|lessons|summaries)\/([^/\\\0]+\.md)$/.exec(id);
  if (!match || Buffer.byteLength(match[2]) > 255) throw new Error('Memory ID must be kind/filename.md within this workspace');
  return { kind: kindSchema.parse(match[1]), filename: match[2] };
}

async function directory(path: string, create = false): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Memory directory must be a real directory: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!create) return false;
    await mkdir(path, { mode: 0o700 });
    return directory(path);
  }
}

export async function memoryFolder(workspace: string, kind?: MemoryKind, create = false): Promise<string | undefined> {
  if (await realpath(workspace) !== workspace) throw new Error('Workspace path changed; reopen the memory service');
  const root = join(workspace, 'memory');
  if (!await directory(root, create)) return;
  if (!kind) return root;
  const folder = join(root, kind);
  return await directory(folder, create) ? folder : undefined;
}

export async function boundedRead(path: string): Promise<{ markdown: string; modified: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Memory source must be a regular file');
    if (info.size > MAX_MEMORY_BYTES) throw new Error('Memory file exceeds 64 KiB');
    const buffer = Buffer.alloc(MAX_MEMORY_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_MEMORY_BYTES) throw new Error('Memory file exceeds 64 KiB');
    return { markdown: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)), modified: info.mtime.toISOString() };
  } finally { await handle.close(); }
}

function parseDocument(workspace: string, id: string, markdown: string, modified: string): MemoryDocument {
  const { kind } = memoryId(id);
  let createdAt = modified;
  let provenance: MemoryProvenance | undefined;
  const metadata = metadataPattern.exec(markdown);
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata[1]);
      if (typeof parsed.createdAt === 'string' && Number.isFinite(Date.parse(parsed.createdAt))) createdAt = parsed.createdAt;
      if (parsed.provenance && typeof parsed.provenance === 'object') {
        provenance = Object.fromEntries(['sessionId', 'turnId', 'importedFrom', 'importedHash'].flatMap(key => typeof parsed.provenance[key] === 'string' ? [[key, parsed.provenance[key]]] : []));
      }
    } catch { /* Optional metadata never prevents reading ordinary Markdown. */ }
  }
  const content = markdown.replace(metadataPattern, '').trim();
  const heading = /^# ([^\r\n]+)(?:\r?\n|$)/.exec(content);
  return {
    id, kind, source: join(workspace, 'memory', id), markdown, hash: contentHash(markdown),
    title: heading?.[1].trim() || basename(id, '.md'), body: heading ? content.slice(heading[0].length).trim() : content,
    createdAt, updatedAt: modified, ...(provenance ? { provenance } : {}),
  };
}

export async function readDocument(workspace: string, id: string): Promise<MemoryDocument> {
  const { kind, filename } = memoryId(id);
  const folder = await memoryFolder(workspace, kind);
  if (!folder) throw new Error(`Memory not found: ${id}`);
  const { markdown, modified } = await boundedRead(join(folder, filename));
  return parseDocument(workspace, id, markdown, modified);
}

export async function scanDocuments(workspace: string, warn: (text: string) => void): Promise<MemoryDocument[]> {
  const documents: MemoryDocument[] = [];
  const root = await memoryFolder(workspace);
  if (!root) return documents;
  for (const kind of MEMORY_KINDS) {
    let folder: string | undefined;
    try { folder = await memoryFolder(workspace, kind); }
    catch (error) { warn(`${kind}: ${error instanceof Error ? error.message : error}`); continue; }
    if (!folder) continue;
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith('.md')) continue;
      const id = `${kind}/${entry.name}`;
      try {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Memory source must be a regular file, not a symlink');
        documents.push(await readDocument(workspace, id));
      } catch (error) {
        if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        warn(`${id}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  return documents;
}

export function draftMemory(workspace: string, kind: MemoryKind, title: string, body: string, provenance?: MemoryProvenance): MemoryDraft {
  const valid = saveMemorySchema.parse({ kind, title, body });
  const id = `${valid.kind}/${randomUUID()}.md`;
  const metadata = JSON.stringify({ createdAt: new Date().toISOString(), ...(provenance ? { provenance } : {}) }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  const markdown = `# ${valid.title}\n\n${valid.body}\n\n<!-- harness-memory: ${metadata} -->\n`;
  if (Buffer.byteLength(markdown) > MAX_MEMORY_BYTES) throw new Error('Memory file exceeds 64 KiB including metadata');
  return { id, source: join(workspace, 'memory', id), markdown };
}

export async function writeDraft(workspace: string, draft: MemoryDraft, signal?: AbortSignal): Promise<void> {
  const { kind, filename } = memoryId(draft.id);
  if (draft.source !== join(workspace, 'memory', draft.id) || Buffer.byteLength(draft.markdown) > MAX_MEMORY_BYTES) throw new Error('Invalid memory destination or size');
  signal?.throwIfAborted();
  const folder = (await memoryFolder(workspace, kind, true))!;
  try { await lstat(join(folder, filename)); throw new Error('Memory destination already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(folder, `.${filename}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(draft.markdown, 'utf8'); await handle.close();
    signal?.throwIfAborted();
    await rename(temporary, join(folder, filename));
  } finally {
    await handle.close();
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}

export async function removeDocument(workspace: string, id: string): Promise<void> {
  await readDocument(workspace, id); // Validate the complete boundary before deleting.
  await unlink(join(workspace, 'memory', id));
}

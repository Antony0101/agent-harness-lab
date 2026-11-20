import { createServer, createConnection, type Socket } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { message, object } from '../util.js';
import { LOCAL_TOOL_NAMES } from '../workspace-tools/types.js';

const MAX_FRAME_BYTES = 1024 * 1024; // Includes JSON escaping of a complete 64 KiB Markdown source.
type OperationHandler = (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;

// The same private socket carries approval requests and parent-owned memory
// operations. The MCP child never opens SQLite or writes memory Markdown.
export async function approvalBroker(
  decide: (name: string, args: unknown, signal?: AbortSignal) => Promise<boolean>, memory?: OperationHandler, workspace?: OperationHandler,
) {
  const directory = await mkdtemp(join(tmpdir(), 'learning-harness-'));
  await chmod(directory, 0o700);
  const path = join(directory, 'approval.sock');
  const token = randomUUID();
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    const controller = new AbortController();
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); controller.abort(); });
    socket.on('error', () => {});
    let buffer = ''; let received = false;
    socket.setEncoding('utf8'); socket.setTimeout(195_000, () => socket.destroy());
    socket.on('data', chunk => {
      if (received) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      received = true;
      void (async () => {
        try {
          const data = object(JSON.parse(buffer.split('\n')[0]));
          if (data.token !== token) throw new Error('Invalid local operation credential');
          let response: unknown;
          if (data.name === 'journal_append') response = { allowed: await decide(data.name, data.args, controller.signal) };
          else if (memory && ['memory_search', 'memory_read', 'memory_save'].includes(String(data.name))) {
            response = { result: await memory(String(data.name), data.args, controller.signal) };
          } else if (workspace && (LOCAL_TOOL_NAMES as readonly string[]).includes(String(data.name))) {
            response = { result: await workspace(String(data.name), data.args, controller.signal) };
          } else throw new Error('Unsupported local operation');
          const encoded = JSON.stringify(response) + '\n';
          if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) throw new Error('Local result exceeds size limit');
          if (!socket.destroyed) socket.end(encoded);
        } catch (error) { if (!socket.destroyed) socket.end(JSON.stringify({ error: message(error) }) + '\n'); }
      })();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    await chmod(path, 0o600);
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    path, token,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function requestOperation(name: string, args: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const path = process.env.HARNESS_APPROVAL_SOCKET;
  const token = process.env.HARNESS_APPROVAL_TOKEN;
  if (!path || !token) throw new Error('Parent tool/approval service is not connected');
  const frame = JSON.stringify({ token, name, args }) + '\n';
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error('Local request exceeds size limit');
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = ''; let settled = false;
    const abort = () => finish(undefined, new Error('Local tool operation cancelled'));
    const finish = (result?: Record<string, unknown>, error?: Error) => {
      if (settled) return; settled = true; socket.destroy();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result!);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    socket.setTimeout(195_000, () => finish(undefined, new Error('Local operation timed out; do not automatically retry an effectful operation')));
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(frame));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { finish(undefined, new Error('Local result exceeds size limit')); return; }
      if (!buffer.includes('\n')) return;
      try {
        const result = object(JSON.parse(buffer.split('\n')[0]));
        if (typeof result.error === 'string') finish(undefined, new Error(result.error));
        else finish(result);
      } catch (error) { finish(undefined, new Error(message(error))); }
    });
    socket.on('error', error => finish(undefined, error));
    socket.on('close', () => finish(undefined, new Error('Local operation disconnected; save outcome may be unknown')));
  });
}

export async function requestToolApproval(name: string, args: unknown, signal?: AbortSignal): Promise<boolean> {
  try { return (await requestOperation(name, args, signal)).allowed === true; } catch { return false; }
}
export async function requestMemoryOperation(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  return (await requestOperation(name, args, signal)).result;
}
export async function requestWorkspaceOperation(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  return (await requestOperation(name, args, signal)).result;
}

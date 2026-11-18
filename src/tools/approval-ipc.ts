import { createServer, createConnection, type Socket } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { object } from '../util.js';

// A local, private socket lets an MCP handler ask the terminal before any write.
export async function approvalBroker(decide: (name: string, args: unknown) => Promise<boolean>) {
  const directory = await mkdtemp(join(tmpdir(), 'learning-harness-'));
  await chmod(directory, 0o700);
  const path = join(directory, 'approval.sock');
  const token = randomUUID();
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    let received = false;
    socket.setEncoding('utf8');
    socket.setTimeout(125_000, () => socket.destroy());
    socket.on('data', chunk => {
      if (received) return;
      buffer += chunk;
      if (buffer.length > 8192) { socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      received = true;
      void (async () => {
        try {
          const data = object(JSON.parse(buffer.split('\n')[0]));
          if (data.token !== token || data.name !== 'journal_append') throw new Error('Invalid approval request');
          const allowed = await decide(data.name, data.args);
          if (!socket.destroyed) socket.end(JSON.stringify({ allowed }) + '\n');
        } catch { if (!socket.destroyed) socket.end('{"allowed":false}\n'); }
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

export async function requestToolApproval(name: string, args: unknown): Promise<boolean> {
  const path = process.env.HARNESS_APPROVAL_SOCKET;
  const token = process.env.HARNESS_APPROVAL_TOKEN;
  if (!path || !token) return false;
  return new Promise(resolve => {
    const socket = createConnection(path);
    let buffer = '';
    let settled = false;
    const finish = (allowed: boolean) => { if (settled) return; settled = true; socket.destroy(); resolve(allowed); };
    socket.setTimeout(125_000, () => finish(false));
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ token, name, args }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8192) return finish(false);
      if (buffer.includes('\n')) {
        try { finish(object(JSON.parse(buffer.split('\n')[0])).allowed === true); }
        catch { finish(false); }
      }
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}

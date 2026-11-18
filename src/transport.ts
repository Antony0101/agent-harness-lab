import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { killGroup, message, object } from './util.js';

export type RequestId = string | number;
export type WireMessage = {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export function parseMessage(line: string): WireMessage {
  const value = object(JSON.parse(line));
  if ('id' in value && typeof value.id !== 'string' && typeof value.id !== 'number') throw new Error('Invalid request ID');
  if (typeof value.method === 'string') {
    if ('result' in value || 'error' in value) throw new Error('Method message contains a response');
  } else {
    if (!('id' in value) || ('result' in value) === ('error' in value)) throw new Error('Invalid response envelope');
    if ('error' in value) {
      const err = object(value.error);
      if (typeof err.code !== 'number' || typeof err.message !== 'string') throw new Error('Invalid error response');
    }
  }
  return value as WireMessage;
}

export class JsonLines {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  constructor(private receive: (value: WireMessage) => void, private maxBytes = 4 * 1024 * 1024) {}
  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error('Protocol message exceeds size limit');
      if (line) this.receive(parseMessage(line));
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) throw new Error('Protocol line exceeds size limit');
  }
  finish(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) throw new Error('Protocol ended with an incomplete JSON line');
  }
}

export interface Transport extends EventEmitter {
  send(value: WireMessage): void;
  close(): Promise<void>;
}

export class ProcessTransport extends EventEmitter implements Transport {
  private proc: ChildProcessWithoutNullStreams;
  private failed = false;
  private ended: Promise<void>;

  constructor(bin: string, args: string[], cwd: string, env = process.env) {
    super();
    this.proc = spawn(bin, args, { cwd, env, stdio: 'pipe', detached: process.platform !== 'win32', shell: false });
    this.ended = new Promise(resolve => this.proc.once('close', () => resolve()));
    const lines = new JsonLines(value => this.emit('message', value));
    this.proc.stdout.on('data', (chunk: Buffer) => {
      try { lines.push(chunk); } catch (error) { this.fail(new Error(`Invalid protocol: ${message(error)}`)); }
    });
    this.proc.stdout.on('end', () => {
      try { lines.finish(); } catch (error) { this.fail(new Error(message(error))); }
    });
    this.proc.stderr.on('data', (chunk: Buffer) => this.emit('diagnostic', chunk.toString()));
    this.proc.stdin.on('error', error => this.fail(error));
    this.proc.once('error', error => this.fail(error));
    this.proc.once('close', (code, signal) => this.fail(new Error(`Runtime disconnected (exit ${code}, signal ${signal}). Submitted work may have an unknown outcome.`)));
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.emit('disconnect', error);
    killGroup(this.proc.pid, 'SIGTERM');
  }

  send(value: WireMessage): void {
    if (this.failed || this.proc.stdin.destroyed) throw new Error('Runtime is disconnected');
    this.proc.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async close(): Promise<void> {
    this.fail(new Error('Runtime connection closed; unfinished work has an unknown outcome.'));
    this.proc.stdin.end();
    const timer = setTimeout(() => killGroup(this.proc.pid, 'SIGKILL'), 1500);
    try { await this.ended; } finally { clearTimeout(timer); }
  }
}

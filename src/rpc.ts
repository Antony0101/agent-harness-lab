import { EventEmitter } from 'node:events';
import type { Transport, RequestId, WireMessage } from './transport.js';

export class RpcError extends Error {
  constructor(public code: number, text: string, public data?: unknown) { super(text); }
}

export class Rpc extends EventEmitter {
  private nextId = 0;
  private pending = new Map<RequestId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private disconnected?: Error;
  constructor(readonly transport: Transport, private timeoutMs = 30_000) {
    super();
    transport.on('message', (value: WireMessage) => this.receive(value));
    transport.on('disconnect', (error: Error) => this.disconnect(error));
  }

  private receive(value: WireMessage): void {
    if (this.disconnected) return;
    this.emit('wire', 'in', value);
    if (value.method !== undefined) {
      this.emit(value.id !== undefined ? 'request' : 'notification', value);
      return;
    }
    const waiter = this.pending.get(value.id!);
    if (!waiter) { this.emit('orphan', value); return; }
    clearTimeout(waiter.timer);
    this.pending.delete(value.id!);
    if (value.error) waiter.reject(new RpcError(value.error.code, value.error.message, value.error.data));
    else waiter.resolve(value.result);
  }

  private send(value: WireMessage): void {
    if (this.disconnected) throw this.disconnected;
    this.emit('wire', 'out', value);
    this.transport.send(value);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.disconnected) return Promise.reject(this.disconnected);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // An acknowledgment can be lost after work started. Never retry it automatically.
        this.disconnect(new Error(`${method} acknowledgment timed out; outcome unknown. Reconnect and inspect history before retrying.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.send({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { this.disconnect(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  notify(method: string, params?: unknown): void { this.send({ method, ...(params === undefined ? {} : { params }) }); }
  respond(id: RequestId, result: unknown): void { this.send({ id, result }); }
  reject(id: RequestId, code: number, text: string): void { this.send({ id, error: { code, message: text } }); }

  disconnect(error: Error): void {
    if (this.disconnected) return;
    this.disconnected = error;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.emit('disconnect', error);
  }
  async close(): Promise<void> {
    this.disconnect(new Error('Connection closed'));
    await this.transport.close();
  }
}

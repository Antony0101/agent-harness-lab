import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { CodexClient, Turn } from './codex.js';
import { Approvals, type ApprovalOption } from './approvals.js';
import { type AppStatus, type SessionRecord, Store } from './store.js';
import { EventRenderer } from './events.js';
import type { WireMessage } from './transport.js';
import { composeTask } from './context.js';
import type { MemoryService } from './memory/service.js';
import { deferred, message, object, string } from './util.js';

export type TurnResult = { id: string; status: string; text: string; error?: unknown };
type Active = {
  id?: string; done: ReturnType<typeof deferred<TurnResult>>;
  messages: Map<string, string>; controller: AbortController; timer?: NodeJS.Timeout;
};

export class Session {
  record?: SessionRecord;
  status: AppStatus = 'idle';
  memory = true;
  private active?: Active;
  private switching = false;
  private serverRequests = new Set<string>();
  private shuttingDown = false;
  private connectionTrace = `connection-${randomUUID()}`;

  constructor(readonly client: CodexClient, readonly store: Store, readonly approvals: Approvals,
    private renderer: EventRenderer, private write: (text: string) => void, readonly version: string,
    private maxTurnMs = 10 * 60_000, readonly memories?: MemoryService) {
    client.rpc.on('wire', (direction: 'in' | 'out', payload: WireMessage) => {
      const p = payload.params && typeof payload.params === 'object' ? object(payload.params) : {};
      void store.append(this.record?.id ?? this.connectionTrace, {
        direction, method: payload.method ?? 'response', payload,
        ...(typeof p.threadId === 'string' ? { threadId: p.threadId } : {}),
        ...(typeof p.turnId === 'string' ? { turnId: p.turnId } : {}),
      }).catch(error => this.fail(new Error(`Event persistence failed: ${message(error)}`)));
    });
    client.rpc.on('notification', (event: WireMessage) => {
      try { this.notification(event); } catch (error) { this.fail(new Error(`Invalid runtime event: ${message(error)}`)); }
    });
    client.rpc.on('request', (request: WireMessage) => {
      void this.serverRequest(request).catch(error => {
        try { client.rpc.reject(request.id!, -32603, message(error)); } catch { /* disconnect already reported */ }
      });
    });
    client.rpc.on('disconnect', (error: Error) => {
      if (this.shuttingDown && !this.active) return;
      this.fail(error);
    });
    approvals.on('change', (waiting: boolean) => {
      if (this.active && this.status !== 'interrupting') {
        this.status = waiting ? 'waitingForApproval' : 'running';
        this.persistStatus();
      }
    });
  }

  get busy() { return !!this.active || this.switching; }
  get turnId() { return this.active?.id; }
  get toolSignal() { return this.active?.controller.signal; }
  get traceId() { return this.record?.id ?? this.connectionTrace; }
  private persistStatus() {
    if (!this.record) return;
    this.record.lastKnownStatus = this.status;
    this.record.updatedAt = new Date().toISOString();
    void this.store.save('sessions', this.record.id, { ...this.record }).catch(error => this.fail(new Error(`Session persistence failed: ${message(error)}`)));
  }
  private fail(error: Error) {
    const first = this.status !== 'disconnected' && this.status !== 'unknown';
    this.status = this.active ? 'unknown' : 'disconnected';
    const active = this.active;
    this.active = undefined;
    active?.controller.abort();
    if (active?.timer) clearTimeout(active.timer);
    this.approvals.cancelAll();
    this.serverRequests.clear();
    active?.done.reject(error);
    // The store may itself be broken; avoid recursively trying to persist failures.
    if (this.record) {
      this.record.lastKnownStatus = this.status;
      void this.store.save('sessions', this.record.id, { ...this.record }).catch(() => {});
    }
    if (first) this.write(`\n[disconnected] ${error.message}\n`);
  }
  private assertIdle() {
    if (this.busy) throw new Error('A turn or session operation is already active');
    if (this.status === 'disconnected' || this.status === 'unknown') throw new Error('Restart the harness and explicitly resume; do not blindly resend work.');
  }
  async fresh(): Promise<void> {
    this.assertIdle(); this.switching = true;
    try {
      const thread = await this.client.start();
      const now = new Date().toISOString();
      this.record = { schemaVersion: 1, id: randomUUID(), codexThreadId: thread.id, workspace: thread.cwd, runtimeVersion: this.version, createdAt: now, updatedAt: now, lastKnownStatus: 'idle' };
      this.status = 'idle';
      await this.store.save('sessions', this.record.id, this.record);
      this.write(`[session ${this.record.id}] thread ${thread.id}\n`);
    } finally { this.switching = false; }
  }
  async resume(id: string): Promise<void> {
    this.assertIdle(); this.switching = true;
    try {
      const record = await this.store.session(id);
      const previousStatus = record.lastKnownStatus;
      if (resolve(record.workspace) !== resolve(this.client.options.workspace)) throw new Error(`Session workspace is ${record.workspace}; restart with --workspace pointing there.`);
      if (record.runtimeVersion !== this.version) this.write(`[runtime changed] ${record.runtimeVersion} → ${this.version}\n`);
      const thread = await this.client.resume(record.codexThreadId);
      if (thread.status.type === 'active' || thread.status.type === 'systemError') throw new Error(`Runtime thread is ${thread.status.type}; inspect its history before continuing. No new turn was sent.`);
      this.record = record; this.status = 'idle'; this.persistStatus();
      await this.store.flush();
      this.write(`[resumed ${id}] previous local status: ${previousStatus}. No action has been replayed.\n`);
    } finally { this.switching = false; }
  }
  async run(task: string): Promise<TurnResult> {
    this.assertIdle();
    if (!this.record) throw new Error('Create or resume a session first');
    string(task, 'task');
    const active: Active = { done: deferred<TurnResult>(), messages: new Map(), controller: new AbortController() };
    // Register completion before submission: the runtime may finish before its ack arrives.
    void active.done.promise.catch(() => {});
    this.active = active; this.status = 'running'; this.persistStatus();
    active.timer = setTimeout(() => {
      this.fail(new Error('Turn time limit reached. Outcome unknown; inspect history before continuing.'));
      void this.client.rpc.close();
    }, this.maxTurnMs);
    try {
      const context = this.memory && this.memories ? await this.memories.recall(task) : undefined;
      if (context?.warning) this.write(`[memory] ${context.warning}\n`);
      if (context?.items.length) {
        this.write(`[context] ${context.items.length} workspace memories / ${context.characters} characters${context.truncated ? ' (truncated)' : ''}\n`);
        for (const item of context.items) this.write(`  ${item.id} / ${item.reason} / ${item.source}\n`);
      }
      if (this.active !== active) return await active.done.promise;
      const turn = await this.client.turn(this.record.codexThreadId, composeTask(task, context));
      if (this.active === active) {
        active.id ??= turn.id;
        if (turn.status !== 'inProgress') this.complete(turn);
      }
      const result = await active.done.promise;
      await this.store.flush();
      return result;
    } catch (error) {
      if (this.active === active) this.fail(new Error(`Turn submission/execution failed: ${message(error)}. Inspect history before retrying.`));
      throw error;
    }
  }
  private complete(turn: Turn): void {
    const active = this.active;
    if (!active || (active.id && active.id !== turn.id)) return;
    if (!['completed', 'failed', 'interrupted'].includes(turn.status)) throw new Error('Invalid terminal turn status');
    this.active = undefined;
    active.controller.abort();
    if (active.timer) clearTimeout(active.timer);
    this.serverRequests.clear();
    this.approvals.cancelTurn(turn.id);
    this.status = 'idle'; this.persistStatus();
    const text = [...active.messages.values()].join('\n') || turn.items?.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n') || '';
    active.done.resolve({ id: turn.id, status: turn.status, text, ...(turn.error ? { error: turn.error } : {}) });
  }
  private notification(event: WireMessage): void {
    const p = event.params && typeof event.params === 'object' ? object(event.params) : {};
    if (typeof p.threadId === 'string' && this.record && p.threadId !== this.record.codexThreadId) return;
    if (event.method === 'serverRequest/resolved') {
      const key = `runtime:${typeof p.requestId}:${String(p.requestId)}`;
      this.serverRequests.delete(key); this.approvals.cancel(key);
    }
    if (event.method === 'turn/started' && this.active) this.active.id ??= string(object(p.turn).id);
    if (event.method === 'item/completed' && this.active) {
      const item = object(p.item);
      if (item.type === 'agentMessage' && typeof item.text === 'string') this.active.messages.set(string(item.id), item.text);
    }
    this.renderer.render(event);
    if (event.method === 'turn/completed' && this.active) this.complete(object(p.turn) as unknown as Turn);
  }
  async interrupt(): Promise<void> {
    if (!this.active) return;
    if (!this.active.id) throw new Error('Task submission is still awaiting acknowledgment; try /stop after it starts.');
    this.status = 'interrupting'; this.persistStatus(); this.approvals.cancelAll();
    this.active.controller.abort();
    await this.client.interrupt(this.record!.codexThreadId, this.active.id);
  }
  async toolApproval(name: string, args: unknown, signal?: AbortSignal): Promise<boolean> {
    const active = this.active;
    const writesAllowed = () => this.client.options.writable && this.status !== 'interrupting';
    if (!writesAllowed() || !active?.id || signal?.aborted) return false;
    const id = `tool-${randomUUID()}`;
    const cancel = () => this.approvals.cancel(id);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const allowed = await this.approvals.request({ id, title: name, details: args, threadId: this.record?.codexThreadId, turnId: active.id,
        options: [{ label: 'Deny', value: false }, { label: name === 'memory_save' ? 'Save this memory' : name === 'project_check' ? 'Run this check' : name === 'todo_update' ? 'Apply task changes' : 'Allow this append', value: true }] });
      return allowed === true && this.active === active && writesAllowed() && !signal?.aborted;
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  private async serverRequest(request: WireMessage): Promise<void> {
    const p = object(request.params);
    const key = `runtime:${typeof request.id}:${String(request.id)}`;
    const options: ApprovalOption[] = [];
    switch (request.method) {
      case 'item/commandExecution/requestApproval': case 'item/fileChange/requestApproval': {
        const offered = Array.isArray(p.availableDecisions) ? p.availableDecisions : ['decline', 'accept', 'cancel'];
        if (offered.includes('decline')) options.push({ label: 'Decline', value: { decision: 'decline' } });
        else if (offered.includes('cancel')) options.push({ label: 'Cancel', value: { decision: 'cancel' } });
        else { this.client.rpc.reject(request.id!, -32602, 'No supported refusal decision'); return; }
        if (offered.includes('accept')) options.push({ label: 'Accept this action', value: { decision: 'accept' } });
        break;
      }
      case 'item/permissions/requestApproval':
        options.push({ label: 'Deny additional permissions', value: { permissions: {}, scope: 'turn' } });
        options.push({ label: 'Grant requested permissions for this turn', value: { permissions: p.permissions, scope: 'turn' } });
        break;
      case 'mcpServer/elicitation/request':
        // Form/URL interaction is not implemented. A supported decline keeps the turn moving.
        this.client.rpc.respond(request.id!, { action: 'decline', content: null }); return;
      case 'item/tool/requestUserInput':
        this.client.rpc.respond(request.id!, { answers: {} }); return;
      default:
        this.client.rpc.reject(request.id!, -32601, `Unsupported server request: ${request.method}`); return;
    }
    const active = this.active;
    if (!active || p.threadId !== this.record?.codexThreadId || (active.id && p.turnId !== active.id)) {
      this.client.rpc.respond(request.id!, options[0].value); return;
    }
    this.serverRequests.add(key);
    const result = await this.approvals.request({ id: key, title: request.method!, details: p, options, threadId: String(p.threadId), turnId: String(p.turnId) });
    if (!this.serverRequests.delete(key)) return; // Resolved remotely or disconnected while waiting.
    this.client.rpc.respond(request.id!, this.active === active && this.status !== 'interrupting' ? result : options[0].value);
  }
  snapshot() {
    return { state: this.status, session: this.record?.id, thread: this.record?.codexThreadId, turn: this.turnId, workspace: this.client.options.workspace, writable: this.client.options.writable, memory: this.memory, runtime: this.version, trace: this.traceId };
  }
  shutdown(): void { this.shuttingDown = true; this.active?.controller.abort(); }
}

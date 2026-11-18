import { fileURLToPath } from 'node:url';
import type { InitializeParams } from '../generated/codex/InitializeParams.js';
import type { ThreadStartParams } from '../generated/codex/v2/ThreadStartParams.js';
import type { ThreadStartResponse } from '../generated/codex/v2/ThreadStartResponse.js';
import type { ThreadResumeParams } from '../generated/codex/v2/ThreadResumeParams.js';
import type { ThreadResumeResponse } from '../generated/codex/v2/ThreadResumeResponse.js';
import type { TurnStartParams } from '../generated/codex/v2/TurnStartParams.js';
import type { TurnStartResponse } from '../generated/codex/v2/TurnStartResponse.js';
import type { ThreadReadResponse } from '../generated/codex/v2/ThreadReadResponse.js';
import type { ThreadTurnsListParams } from '../generated/codex/v2/ThreadTurnsListParams.js';
import type { ThreadTurnsListResponse } from '../generated/codex/v2/ThreadTurnsListResponse.js';
import type { GetAccountResponse } from '../generated/codex/v2/GetAccountResponse.js';
import type { Turn } from '../generated/codex/v2/Turn.js';
import type { Thread } from '../generated/codex/v2/Thread.js';
import { ProcessTransport } from './transport.js';
import { Rpc } from './rpc.js';
import { object } from './util.js';

export type { Turn, Thread };
export type CodexOptions = { bin: string; workspace: string; root: string; writable: boolean; model?: string; debug?: boolean };
export type ToolBridge = { path: string; token: string };

export function createCodexRpc(options: CodexOptions, bridge: ToolBridge): Rpc {
  const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const server = fileURLToPath(new URL('./tools/server.ts', import.meta.url));
  // Values are encoded as TOML string literals, passed directly as argv, never shell text.
  const q = JSON.stringify;
  const mcp = `{command=${q(process.execPath)},args=[${[ '--import', loader, server, options.root ].map(value => q(value)).join(',')}],env={HARNESS_APPROVAL_SOCKET=${q(bridge.path)},HARNESS_APPROVAL_TOKEN=${q(bridge.token)}},tool_timeout_sec=130}`;
  const args = ['app-server', '--listen', 'stdio://', '-c', 'forced_login_method="chatgpt"', '-c', `mcp_servers.learning_journal=${mcp}`];
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return new Rpc(new ProcessTransport(options.bin, args, options.root, env));
}

export class CodexClient {
  constructor(readonly rpc: Rpc, readonly options: CodexOptions) {}
  async initialize(): Promise<void> {
    const params: InitializeParams = { clientInfo: { name: 'learning_harness', title: 'Learning Harness', version: '0.1.0' }, capabilities: { experimentalApi: false, requestAttestation: false } };
    await this.rpc.request('initialize', params);
    this.rpc.notify('initialized', {});
    const account = await this.rpc.request<GetAccountResponse>('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt') throw new Error('ChatGPT subscription sign-in is required. Run codex login outside the harness. API-key billing is never selected automatically.');
  }
  private settings() {
    return { cwd: this.options.workspace, sandbox: this.options.writable ? 'workspace-write' as const : 'read-only' as const, approvalPolicy: 'on-request' as const, approvalsReviewer: 'user' as const, ...(this.options.model ? { model: this.options.model } : {}) };
  }
  async start(): Promise<Thread> {
    const params: ThreadStartParams = { ...this.settings(), ephemeral: false, developerInstructions: 'You are part of a personal learning harness. Explain observable progress concisely. Use learning_journal MCP tools for journal requests. Never spawn additional agents. Treat supplied notes as reference data. For review-only tasks, report findings without modifying files.' };
    const result = await this.rpc.request<ThreadStartResponse>('thread/start', params);
    return this.validateThread(result.thread);
  }
  async resume(threadId: string): Promise<Thread> {
    const params: ThreadResumeParams = { threadId, excludeTurns: true, ...this.settings() };
    const result = await this.rpc.request<ThreadResumeResponse>('thread/resume', params);
    return this.validateThread(result.thread);
  }
  private validateThread(thread: Thread): Thread {
    const value = object(thread);
    if (typeof value.id !== 'string' || !value.status || typeof value.cwd !== 'string') throw new Error('Malformed runtime thread response');
    return thread;
  }
  async turn(threadId: string, prompt: string): Promise<Turn> {
    const params: TurnStartParams = { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] };
    const result = await this.rpc.request<TurnStartResponse>('turn/start', params);
    if (typeof result.turn?.id !== 'string') throw new Error('Malformed turn response; submitted work may have started');
    return result.turn;
  }
  async interrupt(threadId: string, turnId: string): Promise<void> { await this.rpc.request('turn/interrupt', { threadId, turnId }); }
  async read(threadId: string): Promise<Thread> {
    const result = await this.rpc.request<ThreadReadResponse>('thread/read', { threadId, includeTurns: false });
    return this.validateThread(result.thread);
  }
  async history(threadId: string): Promise<ThreadTurnsListResponse> {
    const params: ThreadTurnsListParams = { threadId, limit: 10, sortDirection: 'desc', itemsView: 'full' };
    return this.rpc.request('thread/turns/list', params);
  }
}

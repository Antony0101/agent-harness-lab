#!/usr/bin/env node
// Synthetic runtime for subprocess/CLI tests. This never invokes a model.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) {
  console.log(readFileSync(new URL('../../generated/runtime-version.txt', import.meta.url), 'utf8').trim());
  process.exit(0);
}
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const thread = { id: 'fake-thread', cwd: process.cwd(), status: { type: 'idle' } };
let turn;
let timer;
const finish = (text, status = 'completed') => {
  clearTimeout(timer);
  if (text) {
    send({ method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: turn.id, itemId: 'm', delta: text } });
    send({ method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item: { type: 'agentMessage', id: 'm', text } } });
  }
  send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status } } });
};
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const value = JSON.parse(line);
  const reply = result => send({ id: value.id, result });
  switch (value.method) {
    case 'initialize': reply({}); break;
    case 'account/read': reply({ account: { type: 'chatgpt', planType: 'plus' } }); break;
    case 'thread/start': case 'thread/resume': thread.cwd = value.params.cwd; reply({ thread }); break;
    case 'thread/read': reply({ thread }); break;
    case 'thread/turns/list': reply({ data: [], nextCursor: null }); break;
    case 'turn/start': {
      turn = { id: 'fake-turn', items: [], status: 'inProgress' };
      reply({ turn }); send({ method: 'turn/started', params: { threadId: thread.id, turn } });
      const prompt = value.params.input[0].text;
      if (prompt.includes('[disconnect]')) { process.exit(9); return; }
      if (prompt.includes('[approval]')) {
        send({ id: 'approval-0', method: 'item/fileChange/requestApproval', params: { threadId: thread.id, turnId: turn.id, reason: 'Synthetic test write' } });
      } else timer = setTimeout(() => finish('Simulated result'), prompt.includes('[slow]') ? 3000 : 5);
      break;
    }
    case 'turn/interrupt': reply({}); finish('', 'interrupted'); break;
    default:
      if (value.id === 'approval-0') finish(value.result?.decision === 'accept' ? 'Action approved' : 'Action declined');
  }
});

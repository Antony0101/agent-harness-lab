import { TerminalUI } from '../src/terminal.js';
import { EventRenderer } from '../src/events.js';

const plain = process.argv.includes('--plain');
const ui = new TerminalUI(text => process.stdout.write(text), {
  color: !plain && process.env.NO_COLOR === undefined && (!!process.stdout.isTTY || process.argv.includes('--color')),
  unicode: !plain, columns: process.stdout.columns || 88,
});
let clock = 0;
const renderer = new EventRenderer(() => {}, false, { ui, now: () => clock });
const emit = (method: string, params: unknown) => renderer.render({ method, params });
ui.banner('/home/you/projects/harness/fixtures/sample-project', false);
ui.info('session', 'demo / offline preview');
ui.info('ready', '/help commands  /stop interrupt  /exit quit', 'accent');
ui.heading('You'); ui.body('Inspect sum.mjs and explain its bug without changing files.');
emit('turn/started', { turn: { id: 'demo' } });
emit('item/agentMessage/delta', { turnId: 'demo', itemId: 'a', delta: 'I’ll inspect the implementation and its acceptance check.\n' });
emit('item/completed', { turnId: 'demo', item: { type: 'agentMessage', id: 'a', text: 'I’ll inspect the implementation and its acceptance check.\n' } });
emit('item/started', { turnId: 'demo', item: { type: 'commandExecution', id: 'cmd', command: "cat sum.mjs && cat check.mjs" } });
clock = 420;
emit('item/completed', { turnId: 'demo', item: { type: 'commandExecution', id: 'cmd', status: 'completed', exitCode: 0, aggregatedOutput: [
  'export function sum(values) {', '  return values.reduce((total, value) => total + value, 1);', '}', '', "import assert from 'node:assert/strict';", "import { sum } from './sum.mjs';", 'assert.equal(sum([]), 0);', 'assert.equal(sum([1, 2, 3]), 6);',
].join('\n') } });
emit('item/started', { turnId: 'demo', item: { type: 'mcpToolCall', id: 'tool', server: 'learning_journal', tool: 'journal_search' } });
clock = 560;
emit('item/completed', { turnId: 'demo', item: { type: 'mcpToolCall', id: 'tool', status: 'completed' } });
emit('item/completed', { turnId: 'demo', item: { type: 'agentMessage', id: 'answer', text: 'The accumulator starts at 1. That makes every result one too high, including sum([]).\n\nStart the accumulator at 0. The seeded project codename is Paper Kite.' } });
clock = 2400;
emit('turn/completed', { turn: { id: 'demo', status: 'completed' } });
ui.approval({ id: 'demo-request', title: 'journal_append', details: { entry: 'An observation is tool output supplied to the next model decision.' }, options: [{ label: 'Deny', value: false }, { label: 'Allow this append', value: true }] });
ui.body('This is a visual preview. No model, tools, or writes were executed.', 'muted');

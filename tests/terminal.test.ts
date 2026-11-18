import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalUI } from '../src/terminal.js';
import { EventRenderer } from '../src/events.js';
import { safeText } from '../src/util.js';

test('compact successful command output previews four rows and full mode expands it', () => {
  const output = Array.from({ length: 30 }, (_, i) => `unique-line-${i + 1}`).join('\n');
  const event = { method: 'item/completed', params: { item: { id: 'cmd', type: 'commandExecution', exitCode: 0, aggregatedOutput: output } } };
  let compact = ''; new EventRenderer(text => compact += text).render(event);
  assert.match(compact, /unique-line-4\b/); assert.doesNotMatch(compact, /unique-line-5\b/);
  assert.match(compact, /26 more lines/); assert.match(compact, /\/events --full/);
  let full = ''; new EventRenderer(text => full += text, false, { verbose: true }).render(event);
  assert.match(full, /unique-line-30\b/); assert.doesNotMatch(full, /more lines/);
});
test('failed commands preserve a larger diagnostic preview and failure status', () => {
  let output = ''; const renderer = new EventRenderer(text => output += text);
  renderer.render({ method: 'item/completed', params: { item: { id: 'c', type: 'commandExecution', exitCode: 2, aggregatedOutput: Array.from({ length: 12 }, (_, i) => `error-${i + 1}`).join('\n') } } });
  assert.match(output, /Command failed \(exit 2\)/); assert.match(output, /error-10\b/); assert.doesNotMatch(output, /error-11\b/);
});
test('split deltas preserve spaces and interrupted turns flush trailing words once', () => {
  let output = ''; const renderer = new EventRenderer(text => output += text, false, { columns: 38 });
  renderer.render({ method: 'turn/started', params: { turn: { id: 't' } } });
  for (const delta of ['Read the official ', 'documentation ', 'search results ', 'carefully.']) {
    renderer.render({ method: 'item/agentMessage/delta', params: { turnId: 't', itemId: 'm', delta } });
  }
  renderer.render({ method: 'turn/completed', params: { turn: { id: 't', status: 'interrupted' } } });
  assert.match(output.replace(/\s+/g, ' '), /Read the official documentation search results carefully\./);
  assert.equal(output.match(/carefully\./g)?.length, 1); assert.match(output, /Turn interrupted/);
});
test('terminal controls are removed as sequences and carriage returns preserve word boundaries', () => {
  assert.equal(safeText('\x1b[31mred\x1b[0m\rnext\r\nline'), 'red\nnext\nline');
  assert.equal(safeText('a\x1b[2Jb\x1b]0;bad title\x07c'), 'abc');
});
test('plain layout has no ANSI codes; colored layout sanitizes external ANSI first', () => {
  let plain = ''; const ui = new TerminalUI(text => plain += text, { color: false, unicode: false, columns: 50 });
  ui.banner('/workspace', false); ui.action('Run', '\x1b[2Jread a file');
  assert.doesNotMatch(plain, /\x1b/); assert.match(plain, /HARNESS/); assert.match(plain, /read a file/);
  let colored = ''; const colorUI = new TerminalUI(text => colored += text, { color: true });
  colorUI.body('\x1b[2Jclear screen', 'accent');
  assert.match(colored, /\x1b\[36m/); assert.doesNotMatch(colored, /\x1b\[2J/);
});
test('narrow terminal previews wrap; approval details remain complete', () => {
  let output = ''; const ui = new TerminalUI(text => output += text, { columns: 40 });
  ui.approval({ id: 'r1', title: 'commandExecution', details: { command: 'operate on a very long path with important trailing arguments KEEP_THIS' }, options: [{ label: 'Deny', value: false }] });
  assert.match(output, /KEEP_THIS/); assert.match(output, /\/approve r1/); assert.match(output, /Enter denies/);
  assert.ok(output.split('\n').every(line => Array.from(line).length <= 40));
});

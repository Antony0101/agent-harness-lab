import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TuiModel, type View } from '../src/tui/model.js';
import { TuiApp, type TuiActions } from '../src/tui/app.js';
import { InputDecoder } from '../src/tui/input.js';
import { renderScreen } from '../src/tui/render.js';
import { displayWidth, Editor, flow, wrap } from '../src/tui/text.js';
import { TuiTerminalUI } from '../src/tui/terminal.js';
import { toolCatalog } from '../src/tui/catalog.js';
import { Approvals } from '../src/approvals.js';
import { EventRenderer } from '../src/events.js';

const model = () => new TuiModel({ workspace: '/project/learning-harness', writable: false, runtime: 'test runtime', model: 'test model',
  state: 'idle', memory: true, recalled: 0, recallCharacters: 0 });
function harness(overrides: Partial<TuiActions> = {}) {
  const state = model(); const submitted: string[] = []; const answered: Array<[string, number]> = []; const refreshed: View[] = [];
  const app = new TuiApp(state, {
    submit: text => { submitted.push(text); return true; }, interrupt: () => {}, exit: () => {},
    approve: (id, choice) => { answered.push([id, choice]); state.setApproval(undefined); return true; },
    refresh: async view => { refreshed.push(view); }, readMemory: async () => '# Source\n\nComplete note.', resumeSession: () => true,
    saveMemory: async () => {}, addTask: async () => {}, updateTask: async () => {}, toggleMemory: () => { state.context.memory = !state.context.memory; },
    ...overrides,
  });
  return { state, app, submitted, answered, refreshed };
}
const screen = (state: TuiModel, columns = 100, rows = 32) => renderScreen(state, columns, rows, false).plain.join('\n');
const prompt = (id: string) => ({ id, title: 'Save a note', details: { body: 'A complete proposal.' }, options: [{ label: 'Deny', value: false }, { label: 'Approve once', value: true }] });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('editor moves and deletes Unicode graphemes and preserves multiline draft positions', () => {
  const editor = new Editor(); editor.insert('a👨‍👩‍👧‍👦é中');
  assert.equal(displayWidth(editor.text), 6); editor.backspace(); assert.equal(editor.text, 'a👨‍👩‍👧‍👦é');
  editor.left(); editor.backspace(); assert.equal(editor.text, 'aé'); editor.delete(); assert.equal(editor.text, 'a');
  editor.set('first\nsecond'); editor.home(); assert.equal(editor.cursor, 6); editor.vertical(-1); assert.equal(editor.cursor, 0);
  editor.set('\ntext', 0); editor.home(); assert.equal(editor.cursor, 0);
  assert.deepEqual(wrap('中中a', 4), ['中中', 'a']);
  assert.deepEqual(flow('a readable paragraph', 12), ['a readable', 'paragraph']);
  assert.deepEqual(flow('😀a', 1), ['a']);
});
test('decoder handles fragmented UTF-8, terminal sequences and bracketed paste without submitting', () => {
  const keys: string[] = []; const pastes: string[] = [];
  const decoder = new InputDecoder(key => keys.push(`${key.name}:${key.text ?? ''}`), text => pastes.push(text));
  const encoded = Buffer.from('中'); decoder.write(encoded.subarray(0, 1)); decoder.write(encoded.subarray(1));
  decoder.write('\x1b['); decoder.write('A'); decoder.write('\x1b[200'); decoder.write('~first\n/exit\r\x1b[C'); decoder.write('\x1b[201'); decoder.write('~');
  assert.deepEqual(keys, ['text:中', 'up:']); assert.deepEqual(pastes, ['first\n/exit\r\x1b[C']);
  decoder.write('\x1b[999~'); assert.equal(keys.length, 2);
  decoder.write('\x1b'); decoder.flushEscape(); assert.equal(keys.at(-1), 'escape:'); decoder.close();
});
test('raw Alt shortcuts navigate views across terminal encodings without changing the draft', () => {
  const { state, app, submitted, refreshed } = harness(); state.composer.set('Keep my working draft');
  const decoder = new InputDecoder(key => app.key(key), () => assert.fail('Unexpected paste'));
  for (const encode of [
    (digit: number) => `\x1b${digit}`,
    (digit: number) => `\x1b[${48 + digit};3u`,
    (digit: number) => `\x1b[${48 + digit};3:1u`,
    (digit: number) => `\x1b[27;3;${48 + digit}~`,
  ]) {
    for (const [index, view] of ['conversation', 'tools', 'memory', 'tasks', 'sessions'].entries()) {
      const sequence = Buffer.from(encode(index + 1)); decoder.write(sequence.subarray(0, 2)); decoder.write(sequence.subarray(2));
      assert.equal(state.view, view); assert.equal(state.composer.text, 'Keep my working draft');
    }
  }
  assert.equal(refreshed.length, 20); assert.deepEqual(submitted, []); decoder.close();
});
test('Tab navigation works without Alt and preserves command completion and modal input', () => {
  const { state, app, submitted, answered } = harness(); const decoder = new InputDecoder(key => app.key(key), () => {});
  state.composer.set('Unsent draft');
  for (const view of ['tools', 'memory', 'tasks', 'sessions', 'conversation']) { decoder.write('\t'); assert.equal(state.view, view); }
  decoder.write('\x1b[Z'); assert.equal(state.view, 'sessions'); assert.equal(state.composer.text, 'Unsent draft');
  state.composer.set('/memo'); decoder.write('\x1b[Z'); assert.equal(state.view, 'tasks'); assert.equal(state.composer.text, '/memo');
  decoder.write('\t'); assert.equal(state.composer.text, '/memory'); assert.equal(state.view, 'tasks');
  state.view = 'memory'; app.key({ name: 'new' }); decoder.write('\t'); assert.equal(state.form!.active, 1);
  decoder.write('\x1b[Z'); assert.equal(state.form!.active, 0); assert.equal(state.view, 'memory'); app.key({ name: 'escape' });
  state.setApproval(prompt('navigation')); screen(state); decoder.write('\t\x1b[Z\x1b[49;3u'); assert.equal(state.view, 'memory'); assert.deepEqual(answered, []);
  state.setApproval(undefined); state.composer.set('Unsent draft'); assert.match(screen(state, 44, 17), /Tab\/Shift\+Tab views/);
  assert.deepEqual(submitted, []); decoder.close();
});
test('unsupported encoded keys and fragmented key releases do not leak into drafts', () => {
  const { state, app, submitted } = harness(); state.composer.set('Original');
  const decoder = new InputDecoder(key => app.key(key), () => {});
  decoder.write('\x1b[49;3:'); decoder.write('3u'); decoder.write('\x1b[54;3u'); decoder.write('\x1b[500;'); decoder.write('9u');
  decoder.write(' tail'); assert.equal(state.composer.text, 'Original tail'); assert.equal(state.view, 'conversation'); assert.deepEqual(submitted, []);
  decoder.close();
});
test('responsive screen stays within terminal cells, sanitizes output and hides inaccessible approvals', () => {
  const state = model(); state.add('assistant', 'CODEX', '中 👩‍💻 \x1b[31mvisible\x1b[0m\x1b]52;c;secret\x07\n' + 'Long prose. '.repeat(100));
  state.composer.set('Draft 中\nsecond line');
  for (const [columns, rows] of [[112, 36], [80, 24], [44, 17], [20, 8]]) {
    const frame = renderScreen(state, columns, rows, false);
    assert.equal(frame.lines.length, rows);
    for (const row of frame.plain) { assert.equal(displayWidth(row), columns); assert.doesNotMatch(row, /\x1b|secret/); }
    if (frame.cursor) { assert.ok(frame.cursor.x < columns); assert.ok(frame.cursor.y < rows); }
  }
  state.setApproval(prompt('one')); screen(state); assert.equal(state.shownApproval, 'one');
  screen(state, 20, 8); assert.equal(state.shownApproval, undefined);
  state.setApproval(undefined);
  assert.match(screen(state, 112, 36), /WORKSPACE/);
});
test('structured streaming produces one assistant message and expandable bounded activity', () => {
  const state = model(); let output = '';
  const renderer = new EventRenderer(text => { output += text; }, false, { onEvent: event => state.event(event) });
  renderer.render({ method: 'turn/started', params: { turn: { id: 't' } } });
  for (const delta of ['Hello ', 'world']) renderer.render({ method: 'item/agentMessage/delta', params: { turnId: 't', itemId: 'm', delta } });
  renderer.render({ method: 'item/completed', params: { turnId: 't', item: { id: 'm', type: 'agentMessage', text: 'Hello world' } } });
  renderer.render({ method: 'item/completed', params: { turnId: 't', item: { id: 'c', type: 'commandExecution', command: 'npm test', exitCode: 0,
    aggregatedOutput: Array.from({ length: 30 }, (_, i) => `output ${i}`).join('\n') } } });
  assert.equal(output, ''); assert.equal(state.blocks.filter(block => block.kind === 'assistant').length, 1);
  assert.match(screen(state), /26 more lines/); state.details = true; assert.doesNotMatch(screen(state), /26 more lines/);
  renderer.render({ method: 'turn/completed', params: { turn: { id: 't', status: 'completed', items: [{ id: 'm', type: 'agentMessage', text: 'Hello world' }] } } });
  assert.equal(state.blocks.filter(block => block.kind === 'assistant').length, 1); assert.equal(state.context.state, 'idle');
  const huge = state.add('activity', 'Large output', 'a'.repeat(100000)); assert.equal(huge.text.length, 65536); assert.equal(huge.truncated, true);
});
test('composer preserves refused drafts, supports multiline and slash completion, and browses views', () => {
  const { state, app, submitted, refreshed } = harness({ submit: () => false });
  state.composer.set('Keep this draft'); app.key({ name: 'enter' }); assert.equal(state.composer.text, 'Keep this draft');
  app.key({ name: 'newline' }); app.key({ name: 'text', text: 'Next line' }); assert.equal(state.composer.text, 'Keep this draft\nNext line');
  app.key({ name: 'escape' }); assert.match(state.composer.text, /Keep/);
  state.composer.set('/memo'); app.key({ name: 'tab' }); assert.equal(state.composer.text, '/memory');
  app.key({ name: 'view4' }); assert.equal(state.view, 'tasks'); assert.deepEqual(refreshed, ['tasks']); assert.deepEqual(submitted, []);
});
test('message history restores an unsent draft and command palette inserts without executing', () => {
  const { state, app, submitted } = harness(); state.composer.set('First message'); app.key({ name: 'enter' });
  state.composer.set('My draft'); app.key({ name: 'up' }); assert.equal(state.composer.text, 'First message');
  app.key({ name: 'down' }); assert.equal(state.composer.text, 'My draft');
  app.key({ name: 'palette' }); app.key({ name: 'text', text: 'interrupt' }); app.key({ name: 'enter' });
  assert.equal(state.composer.text, '/stop'); assert.deepEqual(submitted, ['First message']);
});
test('approval defaults to denial, requires the displayed exact ID, and preserves drafts', () => {
  const { state, app, answered } = harness(); state.composer.set('Draft before approval');
  state.setApproval(prompt('first')); app.key({ name: 'enter' }); assert.deepEqual(answered, []);
  screen(state); app.key({ name: 'enter' }); assert.deepEqual(answered, [['first', 0]]);
  state.setApproval(prompt('second')); screen(state); app.key({ name: 'right' });
  state.setApproval(prompt('third')); app.key({ name: 'enter' }); assert.equal(answered.length, 1);
  screen(state); assert.equal(state.approvalChoice, 0); app.key({ name: 'right' }); app.key({ name: 'enter' });
  assert.deepEqual(answered.at(-1), ['third', 1]); assert.equal(state.composer.text, 'Draft before approval');
  state.setApproval(prompt('fourth')); screen(state); app.key({ name: 'escape' }); assert.deepEqual(answered.at(-1), ['fourth', 0]);
});
test('approval details remain fully scrollable and responsive on narrow terminals', () => {
  const { state, app } = harness(); state.setApproval({ ...prompt('long'), details: { body: 'Important detail\n'.repeat(200) + 'LAST SECRET-FREE DETAIL' } });
  const first = screen(state, 44, 17); assert.match(first, /● Deny/); assert.doesNotMatch(first, /LAST SECRET/);
  app.key({ name: 'bottom' }); assert.match(screen(state, 44, 17), /LAST SECRET/);
});
test('unpainted replacements and removed approval dialogs cannot submit a draft', () => {
  const { state, app, answered, submitted } = harness(); state.composer.set('My unsent draft');
  state.setApproval(prompt('reused')); screen(state); app.key({ name: 'right' });
  state.setApproval(prompt('reused')); app.key({ name: 'enter' }); assert.equal(answered.length, 0); assert.equal(state.approvalChoice, 0);
  screen(state); state.setApproval(undefined); app.key({ name: 'enter' }); assert.deepEqual(submitted, []);
  screen(state); app.key({ name: 'enter' }); assert.deepEqual(submitted, ['My unsent draft']);
});
test('a terminal below the minimum size preserves drafts and refuses hidden interactions', () => {
  const { state, app, submitted } = harness(); state.composer.set('Draft before resize'); screen(state, 30, 10);
  app.key({ name: 'enter' }); app.key({ name: 'text', text: 'hidden' }); assert.deepEqual(submitted, []); assert.equal(state.composer.text, 'Draft before resize');
  screen(state, 80, 24); app.key({ name: 'enter' }); assert.deepEqual(submitted, ['Draft before resize']);
});
test('memory and task forms only write after explicit save and keep failures editable', async () => {
  const saves: string[][] = []; let updates = 0;
  const { state, app } = harness({ saveMemory: async (...args) => { saves.push(args); if (saves.length === 1) throw new Error('Disk full'); }, updateTask: async () => { updates++; } });
  state.view = 'memory'; app.key({ name: 'new' }); app.key({ name: 'tab' }); app.key({ name: 'text', text: 'A fact' });
  app.key({ name: 'tab' }); app.key({ name: 'text', text: 'The body' }); assert.equal(saves.length, 0);
  app.key({ name: 'save' }); await settle(); assert.match(state.form!.error!, /Disk full/); assert.equal(state.form!.fields[2].editor.text, 'The body');
  app.key({ name: 'save' }); await settle(); assert.equal(state.form, undefined); assert.deepEqual(saves.at(-1), ['facts', 'A fact', 'The body']);
  state.view = 'tasks'; state.tasks = [{ id: 'task-one', title: 'First task', status: 'pending' }];
  app.key({ name: 'status' }); app.key({ name: 'right' }); assert.equal(updates, 0);
  app.key({ name: 'escape' }); assert.equal(updates, 0);
  app.key({ name: 'status' }); app.key({ name: 'right' }); app.key({ name: 'save' }); await settle(); assert.equal(updates, 1);
});
test('memory inspection, search and recall controls share a preserved composer', async () => {
  const { state, app, refreshed } = harness(); state.view = 'memory'; state.composer.set('');
  state.memories = [{ id: 'facts/a.md', title: 'A note', kind: 'facts', source: 'memory/facts/a.md' }];
  app.key({ name: 'enter' }); await settle(); assert.match(state.dialog!.text, /Complete note/);
  app.key({ name: 'escape' }); app.key({ name: 'find' }); app.key({ name: 'text', text: 'notes' }); app.key({ name: 'enter' }); await settle();
  assert.equal(state.memoryQuery, 'notes'); assert.deepEqual(refreshed, ['memory']); assert.equal(state.form, undefined);
  app.key({ name: 'toggle' }); assert.equal(state.context.memory, false);
  state.composer.set('Preserved'); app.key({ name: 'view2' }); assert.equal(state.composer.text, 'Preserved');
});
test('small terminal forms keep the focused field, save help and cursor visible', () => {
  const { state, app } = harness(); state.view = 'memory'; app.key({ name: 'new' });
  for (let i = 0; i < 3; i++) {
    const frame = renderScreen(state, 44, 17, false); assert.match(frame.plain.join('\n'), /Ctrl\+S save/);
    if (frame.cursor) assert.ok(frame.cursor.y < 14);
    app.key({ name: 'tab' });
  }
});
test('terminal adapter retains complete text and catalog exposes eleven discoverable tools', () => {
  const state = model(); const ui = new TuiTerminalUI(state);
  ui.heading('Note'); ui.body('One'); ui.body('Two'); assert.equal(state.blocks[0].text, 'One\nTwo');
  ui.fields('Inspect', { id: 'test', nested: { full: true } }); assert.match(state.blocks.at(-1)!.text, /"full": true/);
  ui.write('[error] Something failed'); assert.equal(state.blocks.at(-1)!.status, 'failed');
  const catalog = toolCatalog(process.cwd()); assert.equal(catalog.length, 11); assert.match(catalog[0].example, /Input schema/);
});
class FakeInput extends EventEmitter {
  isTTY = true; isRaw = false; paused = false;
  setRawMode(value: boolean) { this.isRaw = value; return this; }
  isPaused() { return this.paused; } resume() { this.paused = false; return this; } pause() { this.paused = true; return this; }
}
class FakeOutput extends EventEmitter { isTTY = true; columns = 80; rows = 24; text = ''; write(text: string) { this.text += text; return true; } }
test('TUI owns and restores raw mode, alternate screen, cursor, paste mode and listeners', async () => {
  const input = new FakeInput(); const output = new FakeOutput(); const h = harness();
  const app = new TuiApp(h.state, {
    submit: text => { h.submitted.push(text); return true; }, interrupt: () => {}, exit: () => app.close(), approve: () => false, refresh: async () => {},
    readMemory: async () => '', resumeSession: () => false, saveMemory: async () => {}, addTask: async () => {}, updateTask: async () => {}, toggleMemory: () => {},
  }, input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream, false);
  app.start(); assert.equal(input.isRaw, true); assert.match(output.text, /\x1b\[\?1049h/);
  input.emit('data', Buffer.from('\x1b[200~pasted\n/exit\r\x1b[201~')); assert.deepEqual(h.submitted, []); assert.equal(h.state.composer.text, 'pasted\n/exit\n');
  h.state.setApproval(prompt('paste')); renderScreen(h.state, 80, 24);
  input.emit('data', Buffer.from('\x1b[200~\x1b[C\r\x1b[201~')); assert.equal(h.state.approvalChoice, 0);
  app.close(); app.close(); await app.closed;
  assert.equal(input.isRaw, false); assert.equal(input.paused, true); assert.equal(input.listenerCount('data'), 0); assert.equal(output.listenerCount('resize'), 0);
  assert.match(output.text, /\x1b\[\?2004l/); assert.match(output.text, /\x1b\[\?25h/); assert.match(output.text, /\x1b\[\?1049l/);
});
test('unexpected input-handler errors restore the terminal before reporting failure', async () => {
  const input = new FakeInput(); const output = new FakeOutput(); let reported = '';
  const app = new TuiApp(model(), {
    submit: () => { throw new Error('Synthetic input failure'); }, interrupt: () => {}, exit: () => {}, approve: () => false, refresh: async () => {},
    readMemory: async () => '', resumeSession: () => false, saveMemory: async () => {}, addTask: async () => {}, updateTask: async () => {}, toggleMemory: () => {},
    failure: error => { assert.equal(input.isRaw, false); assert.match(output.text, /\x1b\[\?1049l/); reported = error.message; },
  }, input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream, false);
  app.start(); input.emit('data', Buffer.from('hello\r')); await app.closed; assert.equal(reported, 'Synthetic input failure');
});
test('approval expiry and cancellation dismiss the modal without authorizing later requests', async () => {
  const { state } = harness(); const approvals = new Approvals(true, () => {}, 15, new TuiTerminalUI(state));
  approvals.on('change', () => state.setApproval(approvals.active));
  const answer = approvals.request(prompt('expired')); assert.ok(state.approval!.expiresAt! > Date.now());
  assert.equal(await answer, false); assert.equal(state.approval, undefined); assert.equal(approvals.answer('expired', '2'), false);
  const next = approvals.request(prompt('cancelled')); approvals.close(); assert.equal(await next, false); assert.equal(state.approval, undefined);
});

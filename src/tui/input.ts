import { StringDecoder } from 'node:string_decoder';

export type InputKey = { name: string; text?: string };
const escapes: Record<string, string> = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1bOH': 'home', '\x1bOF': 'end',
  '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[3~': 'delete', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1b[Z': 'backtab',
  '\x1b\r': 'newline', '\x1b\n': 'newline', '\x1b[13;2u': 'newline', '\x1b[27;2;13~': 'newline',
  '\x1b[1;5H': 'top', '\x1b[1;5F': 'bottom',
  '\x1bOP': 'help', '\x1b[11~': 'help',
  '\x1b1': 'view1', '\x1b2': 'view2', '\x1b3': 'view3', '\x1b4': 'view4', '\x1b5': 'view5',
};
// Terminals can encode the same Alt shortcut as a legacy ESC prefix, CSI-u,
// or xterm modifyOtherKeys. No decoder can receive a shortcut the host captures.
for (let digit = 1; digit <= 5; digit++) {
  const code = 48 + digit;
  escapes[`\x1b[${code};3u`] = `view${digit}`;
  escapes[`\x1b[${code};3:1u`] = `view${digit}`;
  escapes[`\x1b[27;3;${code}~`] = `view${digit}`;
}
const controls: Record<string, string> = {
  '\r': 'enter', '\n': 'newline', '\t': 'tab', '\x7f': 'backspace', '\b': 'backspace',
  '\x01': 'home', '\x02': 'left', '\x03': 'interrupt', '\x04': 'eof', '\x05': 'expand', '\x06': 'find', '\x14': 'toggle',
  '\x0c': 'redraw', '\x0e': 'new', '\x10': 'palette', '\x11': 'quit', '\x12': 'refresh',
  '\x13': 'save', '\x15': 'clear', '\x17': 'deleteword', '\x18': 'status',
};

/** Bracketed paste is delivered as text, never as executable key presses. */
export class InputDecoder {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private pasted: string | undefined;
  private timer?: NodeJS.Timeout;
  constructor(private key: (key: InputKey) => void, private paste: (text: string) => void) {}
  write(chunk: Buffer | string): void {
    clearTimeout(this.timer);
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.parse();
    if (this.buffer.startsWith('\x1b') && this.pasted === undefined) this.timer = setTimeout(() => this.flushEscape(), 35);
  }
  flushEscape(): void {
    clearTimeout(this.timer);
    if (this.buffer === '\x1b') { this.buffer = ''; this.key({ name: 'escape' }); }
    else if (this.buffer.startsWith('\x1b')) this.buffer = ''; // Ignore unsupported terminal replies/sequences.
  }
  close(): void { clearTimeout(this.timer); this.buffer = ''; this.pasted = undefined; }
  private parse(): void {
    const pasteStart = '\x1b[200~'; const pasteEnd = '\x1b[201~';
    while (this.buffer) {
      if (this.pasted !== undefined) {
        const end = this.buffer.indexOf(pasteEnd);
        if (end < 0) {
          const length = Math.max(0, this.buffer.length - pasteEnd.length + 1);
          this.pasted = (this.pasted + this.buffer.slice(0, length)).slice(0, 65536); this.buffer = this.buffer.slice(length); return;
        }
        const text = (this.pasted + this.buffer.slice(0, end)).slice(0, 65536);
        this.buffer = this.buffer.slice(end + pasteEnd.length); this.pasted = undefined; this.paste(text); continue;
      }
      if (this.buffer.startsWith(pasteStart)) { this.pasted = ''; this.buffer = this.buffer.slice(pasteStart.length); continue; }
      if (this.buffer.startsWith('\x1b')) {
        const sequence = Object.keys(escapes).find(value => this.buffer.startsWith(value));
        if (sequence) { this.buffer = this.buffer.slice(sequence.length); this.key({ name: escapes[sequence] }); continue; }
        if ([pasteStart, ...Object.keys(escapes)].some(value => value.startsWith(this.buffer))) return;
        // Consume complete unsupported CSI sequences (including key releases)
        // as a unit; their parameters must never become draft text or decisions.
        const unknown = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.buffer);
        if (unknown) { this.buffer = this.buffer.slice(unknown[0].length); continue; }
        if (/^\x1b\[[0-?]*[ -/]*$/.test(this.buffer)) return;
        if (this.buffer.length === 1) return;
        this.buffer = this.buffer.slice(1); this.key({ name: 'escape' }); continue;
      }
      const point = this.buffer.codePointAt(0)!; const char = String.fromCodePoint(point); this.buffer = this.buffer.slice(char.length);
      if (controls[char]) this.key({ name: controls[char] });
      else if (point >= 32) this.key({ name: 'text', text: char });
    }
  }
}

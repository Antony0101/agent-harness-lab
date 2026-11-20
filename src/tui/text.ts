import { safeText } from '../util.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = (text: string) => Array.from(segmenter.segment(text), item => item.segment);
export function cellWidth(text: string): number {
  if (!text || /^[\p{Mark}\u200d\ufe0f]+$/u.test(text)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\ufe0f/u.test(text)) return 2;
  const point = text.codePointAt(0)!;
  return point >= 0x1100 && (point <= 0x115f || point === 0x2329 || point === 0x232a
    || (point >= 0x2e80 && point <= 0xa4cf) || (point >= 0xac00 && point <= 0xd7a3)
    || (point >= 0xf900 && point <= 0xfaff) || (point >= 0xfe10 && point <= 0xfe6f)
    || (point >= 0xff01 && point <= 0xff60) || (point >= 0xffe0 && point <= 0xffe6)
    || (point >= 0x20000 && point <= 0x3ffff)) ? 2 : 1;
}
export const displayWidth = (text: string) => graphemes(safeText(text)).reduce((sum, part) => sum + cellWidth(part), 0);
export function clip(text: string, width: number, ellipsis = false): string {
  const clean = safeText(text).replace(/\n/g, ' ');
  if (displayWidth(clean) <= width) return clean;
  let result = ''; let used = 0;
  for (const part of graphemes(clean)) {
    const size = cellWidth(part);
    if (used + size > Math.max(0, width - (ellipsis ? 1 : 0))) break;
    result += part; used += size;
  }
  return result + (ellipsis && width > 0 ? '…' : '');
}
export function wrap(text: string, width: number): string[] {
  width = Math.max(1, width);
  const lines: string[] = [];
  for (const source of safeText(text).replace(/\t/g, '  ').split('\n')) {
    let line = ''; let size = 0;
    for (const part of graphemes(source)) {
      const next = cellWidth(part);
      if (size + next > width && line) { lines.push(line); line = ''; size = 0; }
      if (next <= width) { line += part; size += next; }
    }
    lines.push(line);
  }
  return lines;
}
/** Prose wrapping; the composer uses hard wrapping to keep cursor offsets stable. */
export function flow(text: string, width: number): string[] {
  width = Math.max(1, width); const lines: string[] = [];
  for (const source of safeText(text).replace(/\t/g, '  ').split('\n')) {
    let current = ''; let size = 0; let breakAt = -1; let breakSize = 0;
    for (const part of graphemes(source)) {
      const next = cellWidth(part); if (next > width) continue;
      if (size + next > width && current) {
        if (breakAt >= 0 && breakSize >= width / 3) {
          lines.push(current.slice(0, breakAt)); current = current.slice(breakAt + 1); size = displayWidth(current);
        } else { lines.push(current); current = ''; size = 0; }
        breakAt = current.lastIndexOf(' '); breakSize = breakAt < 0 ? 0 : displayWidth(current.slice(0, breakAt));
      }
      if (part === ' ') { breakAt = current.length; breakSize = size; }
      current += part; size += next;
    }
    lines.push(current);
  }
  return lines;
}

/** Cursor offsets use UTF-16; movement/deletion use grapheme boundaries. */
export class Editor {
  text = '';
  cursor = 0;
  set(text: string, cursor = text.length): void { this.text = safeText(text); this.cursor = Math.min(this.text.length, Math.max(0, cursor)); }
  insert(text: string): void {
    const clean = safeText(text).replace(/\t/g, '  ');
    const available = Math.max(0, 65536 - this.text.length);
    let inserted = ''; for (const part of graphemes(clean)) { if (inserted.length + part.length > available) break; inserted += part; }
    this.text = this.text.slice(0, this.cursor) + inserted + this.text.slice(this.cursor); this.cursor += inserted.length;
  }
  left(): void { this.cursor -= graphemes(this.text.slice(0, this.cursor)).at(-1)?.length ?? 0; }
  right(): void { this.cursor += graphemes(this.text.slice(this.cursor))[0]?.length ?? 0; }
  backspace(): void { const end = this.cursor; this.left(); this.text = this.text.slice(0, this.cursor) + this.text.slice(end); }
  delete(): void { const start = this.cursor; this.right(); this.text = this.text.slice(0, start) + this.text.slice(this.cursor); this.cursor = start; }
  home(): void { this.cursor = this.cursor === 0 ? 0 : this.text.lastIndexOf('\n', this.cursor - 1) + 1; }
  end(): void { const end = this.text.indexOf('\n', this.cursor); this.cursor = end < 0 ? this.text.length : end; }
  deleteWord(): void {
    const before = this.text.slice(0, this.cursor); const start = before.replace(/\s*\S+\s*$/u, '').length;
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor); this.cursor = start;
  }
  vertical(direction: number): void {
    const rows = this.text.split('\n'); const before = this.text.slice(0, this.cursor).split('\n');
    const row = before.length - 1; const column = before.at(-1)!.length; const target = row + direction;
    if (target < 0 || target >= rows.length) return;
    const prefix = rows.slice(0, target).reduce((sum, value) => sum + value.length + 1, 0);
    const desired = Math.min(column, rows[target].length);
    let offset = 0; for (const part of graphemes(rows[target])) { if (offset + part.length > desired) break; offset += part.length; }
    this.cursor = prefix + offset;
  }
}

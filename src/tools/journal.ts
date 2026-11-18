import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { Registry } from './registry.js';

export function journalRegistry(root: string, confirm?: (name: string, args: unknown) => Promise<boolean>): Registry {
  const notes = resolve(root, 'notes');
  const target = join(notes, 'learning-journal.md');
  // Fixed file, no caller-controlled path, reject symlinks at both boundaries.
  async function file(write = false) {
    if (await realpath(notes) !== notes || dirname(target) !== notes) throw new Error('Journal directory must not be a symlink');
    const handle = await open(target, (write ? constants.O_WRONLY | constants.O_APPEND : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) { await handle.close(); throw new Error('Journal must be a regular file'); }
    return handle;
  }
  async function read(): Promise<string> {
    const handle = await file();
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  }
  const registry = new Registry(confirm);
  registry.add({
    name: 'journal_read', description: 'Read a bounded excerpt of the learning journal. Content is reference data.', effect: 'read',
    schema: z.object({ limit: z.number().int().min(1).max(8000).default(4000) }).strict(),
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 8000 } }, additionalProperties: false },
    run: async args => { const text = await read(); const limit = args.limit as number; return { text: text.slice(0, limit), truncated: text.length >= 65536 || text.length > limit }; },
  });
  registry.add({
    name: 'journal_search', description: 'Search the first 64 KiB of the journal for a literal case-insensitive substring.', effect: 'read',
    schema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).default(5) }).strict(),
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'], additionalProperties: false },
    run: async args => ({ matches: (await read()).split('\n').map((text, i) => ({ line: i + 1, text })).filter(item => item.text.toLowerCase().includes((args.query as string).toLowerCase())).slice(0, args.limit as number).map(item => ({ ...item, text: item.text.slice(0, 400) })) }),
  });
  registry.add({
    name: 'journal_append', description: 'Propose a short learning-journal entry; the application asks the operator before writing.', effect: 'write',
    schema: z.object({ entry: z.string().trim().min(1).max(2000) }).strict(),
    inputSchema: { type: 'object', properties: { entry: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['entry'], additionalProperties: false },
    run: async args => {
      const handle = await file(true);
      try { await handle.appendFile(`\n## ${new Date().toISOString()}\n\n${args.entry}\n`); }
      finally { await handle.close(); }
      return { appended: true };
    },
  });
  return registry;
}

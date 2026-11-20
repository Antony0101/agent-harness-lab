import { resolve } from 'node:path';
import type { TerminalUI } from '../terminal.js';
import { boundedRead, contentHash } from './files.js';
import { kindSchema, type MemoryProvenance, type MemorySaveResult } from './types.js';
import type { MemoryService } from './service.js';

export async function memoryCommand(raw: string, service: MemoryService, ui: TerminalUI, options: {
  enabled: () => boolean; setEnabled: (value: boolean) => void; provenance?: () => MemoryProvenance;
}): Promise<void> {
  const input = raw.trim();
  const action = input.split(/\s/, 1)[0];
  const arg = input.slice(action.length).trim();
  const saved = (result: MemorySaveResult, title = 'MEMORY SAVED') => {
    ui.fields(title, { id: result.id, source: result.source, indexed: result.indexed });
    if (result.warning) ui.notice('MEMORY INDEX', result.warning);
  };
  switch (action) {
    case '':
      ui.fields('PROJECT MEMORY', {
        automaticRecall: options.enabled(), workspace: service.workspace, markdown: service.directory,
        sqlite: service.databasePath, budget: '6000 characters', lastRecallCharacters: service.lastRecall.characters,
        lastRecallWarning: service.lastRecall.warning,
      });
      for (const item of service.lastRecall.items) {
        ui.fields(item.title, { id: item.id, source: item.source, reason: item.reason, characters: item.text.length, truncated: item.truncated });
        ui.body(item.text);
      }
      return;
    case 'on': case 'off':
      if (arg) throw new Error('Usage: /memory on|off');
      options.setEnabled(action === 'on');
      ui.info('memory', `Automatic recall ${action}. Explicit memory commands and tools remain available.`); return;
    case 'list': {
      const records = await service.list(arg ? kindSchema.parse(arg) : undefined);
      ui.rule(`MEMORIES / ${records.length}`);
      for (const record of records) { ui.body(record.id); ui.body(record.title, 'muted'); }
      return;
    }
    case 'search': {
      if (!arg) throw new Error('Usage: /memory search <query>');
      const hits = await service.search(arg);
      ui.rule(`MEMORY SEARCH / ${hits.length} MATCHES`);
      for (const hit of hits) { ui.fields(hit.title, { id: hit.id, source: hit.source, kind: hit.kind }); ui.body(hit.snippet); }
      return;
    }
    case 'read': {
      if (!arg) throw new Error('Usage: /memory read <id>');
      const document = await service.read(arg);
      ui.fields('MEMORY SOURCE', { id: document.id, source: document.source }); ui.body(document.markdown); return;
    }
    case 'add': {
      const match = /^(\S+)\s+([\s\S]+?)\s+::\s+([\s\S]+)$/.exec(arg);
      if (!match) throw new Error('Usage: /memory add <kind> <title> :: <body>');
      saved(await service.add(kindSchema.parse(match[1]), match[2], match[3], options.provenance?.())); return;
    }
    case 'forget':
      if (!arg) throw new Error('Usage: /memory forget <id>');
      saved(await service.forget(arg), 'MEMORY REMOVED'); return;
    case 'rebuild': {
      if (arg) throw new Error('Usage: /memory rebuild');
      const result = await service.rebuild();
      ui.info('memory', `Rebuilt this workspace's index from ${result.indexed} Markdown files.`); return;
    }
    case 'import': {
      const match = /^(\S+)\s+([\s\S]+)$/.exec(arg);
      if (!match) throw new Error('Usage: /memory import <kind> <file>');
      let file = match[2].trim();
      if ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'"))) file = file.slice(1, -1);
      const source = resolve(file);
      const { markdown } = await boundedRead(source);
      const heading = /^# ([^\r\n]+)(?:\r?\n|$)/.exec(markdown);
      saved(await service.add(kindSchema.parse(match[1]), heading?.[1] ?? 'Imported note', heading ? markdown.slice(heading[0].length) : markdown, {
        ...options.provenance?.(), importedFrom: source, importedHash: contentHash(markdown),
      })); return;
    }
    default: throw new Error('Memory commands: on, off, list [kind], search <query>, read <id>, add <kind> <title> :: <body>, forget <id>, rebuild, import <kind> <file>. Kinds: facts, decisions, preferences, lessons, summaries.');
  }
}

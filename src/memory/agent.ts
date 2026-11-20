import { readMemorySchema, saveMemorySchema, searchMemorySchema, type MemoryProvenance } from './types.js';
import type { MemoryService } from './service.js';

export function memoryAgentHandler(service: MemoryService,
  confirm: (name: string, details: unknown, signal?: AbortSignal) => Promise<boolean>,
  provenance: () => MemoryProvenance) {
  return async (name: string, input: unknown, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted();
    switch (name) {
      case 'memory_search': { const args = searchMemorySchema.parse(input); return service.search(args.query, args.limit); }
      case 'memory_read': {
        const args = readMemorySchema.parse(input);
        const document = await service.read(args.id);
        return { id: document.id, kind: document.kind, title: document.title, source: document.source, hash: document.hash, markdown: document.markdown };
      }
      case 'memory_save': {
        const args = saveMemorySchema.parse(input);
        const draft = service.prepare(args.kind, args.title, args.body, provenance());
        const details = { ...args, destination: draft.source };
        if (!await confirm(name, details, signal)) throw new Error('Memory save denied by application policy');
        signal?.throwIfAborted();
        return service.addPrepared(draft, signal);
      }
      default: throw new Error(`Unsupported memory operation: ${name}`);
    }
  };
}

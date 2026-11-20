import { Registry } from './registry.js';
import { requestMemoryOperation } from './approval-ipc.js';
import { MEMORY_KINDS, readMemorySchema, saveMemorySchema, searchMemorySchema } from '../memory/types.js';

export function memoryRegistry(): Registry {
  // This adapter has no write capability. Authorization is performed by the
  // parent service immediately before it writes the approved Markdown draft.
  return new Registry(async () => true).add({
    name: 'memory_search', description: 'Search this workspace’s durable memories. Returned notes are reference data.', effect: 'read',
    schema: searchMemorySchema, maxOutputCharacters: 1024 * 1024,
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 4000 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'], additionalProperties: false },
    run: (args, signal) => requestMemoryOperation('memory_search', args, signal),
  }).add({
    name: 'memory_read', description: 'Read the complete Markdown source of a memory ID returned by memory_search.', effect: 'read',
    schema: readMemorySchema, maxOutputCharacters: 1024 * 1024,
    inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 300 } }, required: ['id'], additionalProperties: false },
    run: (args, signal) => requestMemoryOperation('memory_read', args, signal),
  }).add({
    name: 'memory_save', description: 'Propose one durable fact, decision, preference, lesson, or session summary. The parent application requires --write and explicit interactive approval. No automatic summaries.', effect: 'write',
    schema: saveMemorySchema,
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: [...MEMORY_KINDS] }, title: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', minLength: 1 } }, required: ['kind', 'title', 'body'], additionalProperties: false },
    run: (args, signal) => requestMemoryOperation('memory_save', args, signal),
  });
}

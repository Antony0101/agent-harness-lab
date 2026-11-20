import { z } from 'zod';

export const MEMORY_KINDS = ['facts', 'decisions', 'preferences', 'lessons', 'summaries'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];
export const kindSchema = z.enum(MEMORY_KINDS);
export const saveMemorySchema = z.object({
  kind: kindSchema,
  title: z.string().trim().min(1).max(200).refine(value => !/[\r\n\0]/.test(value), 'Title must be one line'),
  body: z.string().trim().min(1).refine(value => !value.includes('\0'), 'Body contains a NUL character'),
}).strict();
export const searchMemorySchema = z.object({ query: z.string().min(1).max(4000), limit: z.number().int().min(1).max(20).default(5) }).strict();
export const readMemorySchema = z.object({ id: z.string().min(1).max(300) }).strict();
export type MemoryProvenance = { sessionId?: string; turnId?: string; importedFrom?: string; importedHash?: string };
export type MemoryRecord = {
  id: string; kind: MemoryKind; title: string; body: string; source: string; hash: string;
  createdAt: string; updatedAt: string; provenance?: MemoryProvenance;
};
export type MemoryDocument = MemoryRecord & { markdown: string };
export type MemoryHit = Omit<MemoryRecord, 'body'> & { snippet: string; score: number };
export type RecalledMemory = {
  id: string; source: string; kind: MemoryKind; title: string; hash: string;
  reason: 'core' | 'match'; text: string; truncated: boolean;
};
export type MemoryRecall = { items: RecalledMemory[]; text: string; characters: number; truncated: boolean; warning?: string };
export type MemorySaveResult = { id: string; source: string; indexed: boolean; warning?: string };

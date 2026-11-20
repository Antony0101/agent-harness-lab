import { z } from 'zod';

export const LOCAL_TOOL_NAMES = ['workspace_search', 'git_inspect', 'project_check', 'todo_list', 'todo_update'] as const;
export type LocalToolName = typeof LOCAL_TOOL_NAMES[number];
export const searchSchema = z.object({
  query: z.string().min(1).max(200).refine(value => !/[\r\n\0]/.test(value), 'Query must be one line'),
  path: z.string().min(1).max(4096).default('.'),
  limit: z.number().int().min(1).max(100).default(20), caseInsensitive: z.boolean().default(true),
}).strict();
export const gitSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  z.object({ operation: z.literal('diff'), staged: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal('log'), limit: z.number().int().min(1).max(50).default(10) }).strict(),
]);
export const CHECK_SCRIPTS = ['test', 'typecheck', 'lint', 'check'] as const;
export const checkSchema = z.object({ script: z.enum(CHECK_SCRIPTS).optional() }).strict();
export const emptySchema = z.object({}).strict();
const title = z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Title must be one line without control characters');
export const statusSchema = z.enum(['pending', 'in_progress', 'completed']);
const changeSchema = z.union([
  z.object({ operation: z.literal('add'), title, status: statusSchema.default('pending') }).strict(),
  z.object({ operation: z.literal('edit'), id: z.string().uuid(), title: title.optional(), status: statusSchema.optional() }).strict()
    .refine(value => value.title !== undefined || value.status !== undefined, 'Edit requires title or status'),
  z.object({ operation: z.literal('remove'), id: z.string().uuid() }).strict(),
]);
export const todoUpdateSchema = z.object({ revision: z.number().int().nonnegative(), changes: z.array(changeSchema).min(1).max(20) }).strict();
export const todoSchema = z.object({ id: z.string().uuid(), title, status: statusSchema, createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
export const todoFileSchema = z.object({
  schemaVersion: z.literal(1), workspace: z.string(), revision: z.number().int().nonnegative(), tasks: z.array(todoSchema).max(100),
}).strict();
export type TodoFile = z.infer<typeof todoFileSchema>;
export type TodoUpdate = z.infer<typeof todoUpdateSchema>;
export type Confirm = (name: string, details: unknown, signal?: AbortSignal) => Promise<boolean>;
export type CallContext = { origin: 'agent' | 'user'; writable: boolean; confirm: Confirm; signal?: AbortSignal };

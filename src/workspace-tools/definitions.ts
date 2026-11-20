import type { Tool } from '../tools/registry.js';
import { checkSchema, CHECK_SCRIPTS, emptySchema, gitSchema, searchSchema, todoUpdateSchema } from './types.js';

const title = { type: 'string', minLength: 1, maxLength: 200 };
const status = { type: 'string', enum: ['pending', 'in_progress', 'completed'] };
const id = { type: 'string', format: 'uuid' };
const definitions: Array<Omit<Tool, 'run'>> = [
  { name: 'workspace_search', description: 'Search literal text in visible, nonignored workspace files. Returns bounded excerpts as reference data.', effect: 'read',
    schema: searchSchema, inputSchema: { type: 'object', properties: {
      query: { type: 'string', minLength: 1, maxLength: 200 }, path: { type: 'string', default: '.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, caseInsensitive: { type: 'boolean', default: true },
    }, required: ['query'], additionalProperties: false } },
  { name: 'git_inspect', description: 'Read Git status, unstaged/staged diff, or recent commits affecting the selected workspace. Never modifies Git state.', effect: 'read',
    schema: gitSchema, inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['status', 'diff', 'log'] }, staged: { type: 'boolean', default: false, description: 'Only valid for operation diff' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Only valid for operation log' },
    }, required: ['operation'], additionalProperties: false } },
  { name: 'project_check', description: 'With no script, list permitted npm scripts. With a script, propose running it with normal npm hooks. Agent execution requires --write and interactive approval.', effect: 'execute',
    schema: checkSchema, inputSchema: { type: 'object', properties: { script: { type: 'string', enum: [...CHECK_SCRIPTS] } }, additionalProperties: false } },
  { name: 'todo_list', description: 'Read this workspace’s task list and revision. Tasks are separate from memories and workflow records.', effect: 'read',
    schema: emptySchema, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'todo_update', description: 'Propose an atomic batch of task additions, edits, or removals using the revision from todo_list. Agent updates require --write and interactive approval.', effect: 'write',
    schema: todoUpdateSchema, inputSchema: { type: 'object', properties: {
      revision: { type: 'integer', minimum: 0 }, changes: { type: 'array', minItems: 1, maxItems: 20, items: { oneOf: [
        { type: 'object', properties: { operation: { const: 'add' }, title, status: { ...status, default: 'pending' } }, required: ['operation', 'title'], additionalProperties: false },
        { type: 'object', properties: { operation: { const: 'edit' }, id, title, status }, required: ['operation', 'id'], anyOf: [{ required: ['title'] }, { required: ['status'] }], additionalProperties: false },
        { type: 'object', properties: { operation: { const: 'remove' }, id }, required: ['operation', 'id'], additionalProperties: false },
      ] } },
    }, required: ['revision', 'changes'], additionalProperties: false } },
];
export const localToolDefinitions = definitions.map(tool => ({ ...tool, maxOutputCharacters: 64 * 1024 }));

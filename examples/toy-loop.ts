import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Registry } from '../src/tools/registry.js';

export type Action = { type: 'final'; text: string } | { type: 'tool'; name: string; args: unknown };
export type Observation = { name: string; text: string; error: boolean };
export type ToyModel = (task: string, observations: Observation[]) => Action;

export async function toyLoop(model: ToyModel, tools: Registry, task: string, write = console.log) {
  const observations: Observation[] = [];
  for (let step = 1; step <= 5; step++) {
    const action = model(task, observations);
    write(`[step ${step}] ${JSON.stringify(action)}`);
    if (action.type === 'final') return { status: 'completed', answer: action.text, observations };
    const result = await tools.call(action.name, action.args);
    const observation = { name: action.name, text: result.content[0].text, error: result.isError === true };
    observations.push(observation); write(`[observation] ${JSON.stringify(observation)}`);
  }
  return { status: 'limit', answer: 'Stopped at the five-iteration limit.', observations };
}

export function toyRegistry() {
  return new Registry().add({
    name: 'note_read', description: 'Read the in-memory teaching note.', effect: 'read',
    schema: z.object({ key: z.literal('convention') }).strict(),
    inputSchema: { type: 'object', properties: { key: { const: 'convention' } }, required: ['key'], additionalProperties: false },
    run: async () => ({ note: 'Empty arrays sum to zero.' }),
  }).add({
    name: 'note_write', description: 'A deliberately denied teaching action.', effect: 'write',
    schema: z.object({}).strict(), inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => { throw new Error('Denied tools must never reach this handler'); },
  }).add({
    name: 'note_error', description: 'A deliberately broken tool.', effect: 'read',
    schema: z.object({}).strict(), inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => { throw new Error('Simulated tool failure'); },
  });
}

export function scriptedModel(mode: string): ToyModel {
  return (_task, observations) => {
    if (observations.length && mode !== 'limit') return { type: 'final', text: observations.at(-1)!.text };
    if (mode === 'unknown') return { type: 'tool', name: 'missing', args: {} };
    if (mode === 'invalid') return { type: 'tool', name: 'note_read', args: { key: 42 } };
    if (mode === 'denied') return { type: 'tool', name: 'note_write', args: {} };
    if (mode === 'error') return { type: 'tool', name: 'note_error', args: {} };
    return { type: 'tool', name: 'note_read', args: { key: 'convention' } };
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const mode = process.argv[2] ?? 'success';
  if (!['success', 'invalid', 'unknown', 'denied', 'error', 'limit'].includes(mode)) throw new Error('Modes: success, invalid, unknown, denied, error, limit');
  console.log('Offline teaching loop: the model below is scripted, not an AI model.');
  console.log(await toyLoop(scriptedModel(mode), toyRegistry(), 'What is the project convention?'));
}

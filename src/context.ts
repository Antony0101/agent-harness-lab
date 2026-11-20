import type { MemoryRecall } from './memory/types.js';

export function composeTask(task: string, context?: MemoryRecall): string {
  return context?.text ? `Current user task:\n${task}${context.text}` : task;
}

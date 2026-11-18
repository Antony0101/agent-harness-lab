import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const target = fileURLToPath(new URL('../fixtures/sample-project/', import.meta.url));
await mkdir(target, { recursive: true });
await copyFile(new URL('../fixtures/templates/sum.mjs', import.meta.url), `${target}/sum.mjs`);
console.log('Reset disposable fixture to its deliberately failing implementation.');

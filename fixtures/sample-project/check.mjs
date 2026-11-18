import assert from 'node:assert/strict';
import { sum } from './sum.mjs';
assert.equal(sum([]), 0, 'An empty array sums to zero');
assert.equal(sum([1, 2, 3]), 6);
assert.equal(sum([-2, 2]), 0);
console.log('All fixture checks passed.');

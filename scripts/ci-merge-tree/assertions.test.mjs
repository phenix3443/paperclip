import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertionProjection } from './assertions.mjs';

test('distinguishes assertion mismatch from cleanup HTTP failure without copying secret payloads', () => {
  const project = assertionProjection();
  const a = project({ message: 'AssertionError: expected false to be true // Object.is equality', actual: false, expected: true });
  const b = project({ message: 'Error: expect(received).toBe(expected)\nExpected: 200\nReceived: 500' });
  assert.equal(a.actual, false); assert.equal(a.expected, true);
  assert.equal(b.actual, 500); assert.equal(b.expected, 200); assert.equal(b.matcher, 'toBe');
  const c = project({ actual: 'secret-token', expected: 'secret-token', message: 'Bearer secret-token server/TOPSECRET.ts:42' });
  assert.deepEqual(c.actual, c.expected);
  assert.doesNotMatch(JSON.stringify(c), /secret-token|TOPSECRET|Bearer/);
  const d = project({ actual: 'different-token', expected: 'secret-token' });
  assert.notDeepEqual(d.actual, d.expected);
});

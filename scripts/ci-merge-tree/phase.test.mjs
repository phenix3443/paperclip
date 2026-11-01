import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runPhase } from './phase.mjs';

function options(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merge-tree-phase-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { name: 'fixture', command: process.execPath, env: { PATH: process.env.PATH },
    cwd: root, privateRoot: root, stage: root, deadline: Date.now() + 10000 };
}

test('a failing phase preserves its original numeric exit and emits only sanitized console evidence', async t => {
  const input = options(t);
  const result = await runPhase({ ...input, args: ['-e', 'console.error("Bearer PRIVATE_SECRET");process.exit(7)'] });
  assert.equal(result.exit, 7); assert.equal(result.status, 'failed');
  assert.doesNotMatch(readFileSync(path.join(input.stage, 'stderr.jsonl'), 'utf8'), /PRIVATE_SECRET|Bearer/);
});

test('the phase deadline terminates a hanging process and preserves timeout as a separate result', async t => {
  const input = options(t);
  const result = await runPhase({ ...input, deadline: Date.now() + 100,
    args: ['-e', 'setInterval(()=>{},10000)'] });
  assert.equal(result.status, 'timed_out'); assert.equal(result.signal, 'SIGTERM');
});

test('setup spawn failures and a pre-exhausted deadline remain explicit', async t => {
  const input = options(t);
  const failed = await runPhase({ ...input, command: '/not/a/command', args: [] });
  assert.equal(failed.status, 'setup_failure');
  const expired = await runPhase({ ...input, deadline: 0, args: [] });
  assert.equal(expired.status, 'timed_out'); assert.equal(expired.exit, null);
});

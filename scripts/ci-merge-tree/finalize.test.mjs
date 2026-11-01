import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { finalize } from './finalize.mjs';

test('setup failure still produces a sealed report with explicit missing evidence', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merge-tree-finalize-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, 'sanitized'); const privateRoot = path.join(root, 'private');
  mkdirSync(stage); mkdirSync(privateRoot);
  writeFileSync(path.join(stage, 'status.json'), JSON.stringify({ row: { arm: 'base', lane: 'chat' }, result: 'setup_dependency_failure', phases: [{ name: 'install', exit: 7, status: 'failed' }] }));
  const status = finalize(root);
  assert.equal(status.result, 'setup_dependency_failure'); assert.equal(status.evidence, 'incomplete');
  assert.equal(status.phases[0].exit, 7);
  const manifest = JSON.parse(readFileSync(path.join(stage, 'manifest.json')));
  assert.ok(manifest.files.some(file => file.name === 'capture-gaps.json'));
  assert.equal(JSON.parse(readFileSync(path.join(stage, 'report.json'))).status.evidence, 'incomplete');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectFixture, safeLog } from './evidence.mjs';

test('fixture projection aliases linked identities and excludes payloads and unknown fields', () => {
  const project = projectFixture();
  const a = project('issues', [{ id: 'secret-id', company_id: 'company-1', status: 'in_progress',
    description: 'secret prompt', encrypted_value: 'vault-secret', name: 'private@example.test' }]);
  const b = project('issue_comments', [{ id: 'comment-1', issue_id: 'secret-id', body: 'secret answer' }]);
  assert.equal(a[0].id, b[0].issue_id);
  assert.equal(a[0].status, 'in_progress');
  assert.equal(a[0].description, undefined);
  assert.equal(a[0].encrypted_value, undefined);
  assert.doesNotMatch(JSON.stringify([a, b]), /secret|company-1|comment-1|private/);
});

test('console output preserves known failure signatures without emitting arbitrary SQL, tokens or paths', () => {
  const value = safeLog('Bearer key-123 SELECT password=secret /home/private\nERROR: canceling statement due to lock timeout\nAssertionError: expected token=secret');
  assert.match(value, /lock_timeout/);
  assert.match(value, /assertion_failure/);
  assert.doesNotMatch(value, /secret|key-123|private|SELECT/);
});

test('upload staging rejects unknown files, links and aggregate size overflow', async t => {
  const { mkdtempSync, writeFileSync, symlinkSync, unlinkSync, rmSync } = await import('node:fs');
  const os = await import('node:os'); const path = await import('node:path');
  const { sealStage } = await import('./evidence.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'merge-tree-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'unknown'), 'credential');
  assert.throws(() => sealStage(root), /stage_entry_denied/);
  unlinkSync(path.join(root, 'unknown'));
  symlinkSync('missing', path.join(root, 'status.json'));
  assert.throws(() => sealStage(root), /stage_file_denied/);
  unlinkSync(path.join(root, 'status.json'));
  writeFileSync(path.join(root, 'status.json'), '{"status":"failed"}');
  assert.throws(() => sealStage(root, 1), /stage_cap_exceeded/);
  const files = sealStage(root);
  assert.equal(files[0].name, 'status.json');
  assert.match(files[0].sha256, /^[a-f0-9]{64}$/);
});

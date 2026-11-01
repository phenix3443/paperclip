import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { verifySource, validateDispatch } from './identity.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merge-tree-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(path.join(root, 'source.txt'), 'original\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fixture');
  return { root, git, expected: { sha: git('rev-parse', 'HEAD'), parents: [] } };
}

test('records exact source identity and rejects changed tracked bytes even with assume-unchanged', t => {
  const { root, git, expected } = fixture(t);
  const before = verifySource(root, expected);
  assert.equal(before.head, expected.sha);
  assert.equal(before.tree, git('rev-parse', 'HEAD^{tree}'));
  assert.match(before.lockSha256, /^[a-f0-9]{64}$/);
  git('update-index', '--assume-unchanged', 'source.txt');
  writeFileSync(path.join(root, 'source.txt'), 'modified\n');
  assert.throws(() => verifySource(root, expected), /source_integrity/);
});

test('rejects a lockfile change, wrong source commit, wrong parents and staged additions', t => {
  const { root, git, expected } = fixture(t);
  assert.throws(() => verifySource(root, { ...expected, sha: '0'.repeat(40) }), /source_identity/);
  assert.throws(() => verifySource(root, { ...expected, parents: ['0'.repeat(40)] }), /source_identity/);
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 8\n');
  assert.throws(() => verifySource(root, expected), /source_integrity/);
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(path.join(root, 'extra.txt'), 'extra');
  git('add', 'extra.txt');
  assert.throws(() => verifySource(root, expected), /source_integrity/);
});

test('permits ignored dependency outputs while checking the tracked source', t => {
  const { root, expected } = fixture(t);
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'node_modules', 'output'), 'generated');
  assert.equal(verifySource(root, expected).trackedStatus, 'unchanged');
});

test('dispatch requires fork, first attempt, immutable tag, exact control SHA and fixed execution key', () => {
  const valid = { repository: 'phenix3443/paperclip', attempt: '1',
    ref: 'refs/tags/ci-merge-tree-one', sha: 'a'.repeat(40), expectedSha: 'a'.repeat(40),
    executionKey: 'original-ci-41235773036-attempt-1-comparison-1' };
  assert.doesNotThrow(() => validateDispatch(valid));
  for (const invalid of [{ repository: 'paperclipai/paperclip' }, { attempt: '2' },
    { ref: 'refs/heads/develop' }, { expectedSha: 'b'.repeat(40) }, { executionKey: 'another' }]) {
    assert.throws(() => validateDispatch({ ...valid, ...invalid }), /dispatch_denied/);
  }
});


test('rejects a tracked symlink replaced by a regular file with matching blob bytes', t => {
  const { root, git } = fixture(t);
  symlinkSync('source.txt', path.join(root, 'link'));
  git('add', 'link'); git('commit', '--quiet', '-m', 'symlink');
  const expected = { sha: git('rev-parse', 'HEAD') };
  assert.equal(verifySource(root, expected).trackedStatus, 'unchanged');
  unlinkSync(path.join(root, 'link'));
  writeFileSync(path.join(root, 'link'), 'source.txt');
  assert.throws(() => verifySource(root, expected), /source_integrity/);
});

test('CLI rejects a symlinked evidence parent that resolves inside source without writing a file', t => {
  const { root } = fixture(t);
  const outer = mkdtempSync(path.join(os.tmpdir(), 'merge-tree-output-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  symlinkSync(root, path.join(outer, 'alias'));
  assert.throws(() => execFileSync(process.execPath, [new URL('./identity-cli.mjs', import.meta.url).pathname,
    'base', 'chat', root, path.join(outer, 'alias', 'identity.json')], { stdio: 'pipe' }),
    error => error.status !== 0 && /evidence_root_must_be_external/.test(error.stderr));
});

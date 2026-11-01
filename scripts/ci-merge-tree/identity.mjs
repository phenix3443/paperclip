import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

export const BASE = '75fa37f30fc1e65d1e936fcc58ad507cb53f88bb';
export const MERGE = '9535ae08127e8ea4e4b951e77d21bb23763be002';
export const HEAD = 'e29ed583fe30f67d4d275b7ef1cdbdfc4fe8f665';
export const EXECUTION_KEY = 'original-ci-41235773036-attempt-1-comparison-1';
export const ROWS = Object.freeze([
  { arm: 'base', lane: 'chat', sha: BASE },
  { arm: 'merge', lane: 'chat', sha: MERGE },
  { arm: 'base', lane: 'e2e', sha: BASE },
  { arm: 'merge', lane: 'e2e', sha: MERGE },
].map(Object.freeze));
export const SPECS = Object.freeze([
  'agent-chat-projects', 'agent-configuration', 'archived-company-url',
  'cloud-auth', 'onboarding', 'plan-task-fixture', 'runner-e2e-dashboard',
].map(name => `tests/e2e/${name}.spec.ts`));

export function validateDispatch({ repository, attempt, ref, sha, expectedSha, executionKey }) {
  if (repository !== 'phenix3443/paperclip' || String(attempt) !== '1'
    || !/^refs\/tags\/ci-merge-tree-[a-zA-Z0-9.-]+$/.test(ref ?? '')
    || !/^[a-f0-9]{40}$/.test(sha ?? '') || sha !== expectedSha
    || executionKey !== EXECUTION_KEY) throw new Error('dispatch_denied');
}

export function fixedRow(arm, lane) {
  const row = ROWS.find(row => row.arm === arm && row.lane === lane);
  if (!row) throw new Error('invalid_fixed_row');
  return row;
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function verifySource(root, expected) {
  if (!path.isAbsolute(root)) throw new Error('source_root_must_be_absolute');
  const text = (...args) => git(root, ...args).toString('utf8').trim();
  const head = text('rev-parse', 'HEAD');
  const parents = text('show', '-s', '--format=%P', 'HEAD').split(' ').filter(Boolean);
  if (head !== expected.sha || (expected.parents && JSON.stringify(parents) !== JSON.stringify(expected.parents))) {
    throw new Error('source_identity_failure');
  }
  const entries = git(root, 'ls-tree', '-rz', '--full-tree', 'HEAD').toString('utf8').split('\0').filter(Boolean);
  const changed = [];
  for (const entry of entries) {
    const [header, name] = entry.split('\t');
    const [mode, kind, oid] = header.split(' ');
    if (kind !== 'blob') throw new Error('source_integrity_unsupported_entry');
    const target = path.resolve(root, name);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('source_integrity_path');
    try {
      const info = lstatSync(target);
      const bytes = mode === '120000'
        ? info.isSymbolicLink() ? Buffer.from(readlinkSync(target)) : null
        : info.isFile() ? readFileSync(target) : null;
      const actualOid = bytes && createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (!bytes || actualOid !== oid
        || (mode === '100755' && !(info.mode & 0o111))
        || (mode === '100644' && (info.mode & 0o111))) changed.push(name);
    } catch { changed.push(name); }
  }
  const indexTree = text('write-tree');
  const tree = text('rev-parse', 'HEAD^{tree}');
  if (changed.length || indexTree !== tree) throw new Error('source_integrity_failure');
  return {
    head, tree, parents, trackedFiles: entries.length, trackedStatus: 'unchanged',
    lockSha256: createHash('sha256').update(readFileSync(path.join(root, 'pnpm-lock.yaml'))).digest('hex'),
    permittedGeneratedRoots: ['node_modules', '**/node_modules', '**/dist', 'server/ui-dist', '.turbo'],
  };
}

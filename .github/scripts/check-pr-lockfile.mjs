#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Checks that pnpm-lock.yaml was not manually edited.
 * Export: checkLockfile(files, prAuthor, prBranch) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { trustedMergeFiles } from './check-pr-migration-order.mjs';

export function checkLockfile(files, prAuthor, prBranch) {
  const lockfileChanged = files.some(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfileChanged) return { passed: true, failures: [] };

  const isRefreshBot =
    prAuthor === 'github-actions[bot]' && ['chore/refresh-lockfile', 'chore/refresh-lockfile-develop'].includes(prBranch);

  return {
    passed: isRefreshBot,
    failures: isRefreshBot ? [] : [
      'You have changes to `pnpm-lock.yaml` — `pr.yml` will hard-fail this PR with a confusing message about lockfile edits. ' +
      'To fix: run `pnpm install` locally, exclude the lockfile from your commit, push again. ' +
      'The lockfile is regenerated automatically by the refresh bot on a schedule.',
    ],
  };
}

export function checkMergedLockfile(base, head, trusted) {
  if (![base, head, trusted].every(sha => /^[0-9a-f]{40}$/.test(sha ?? ''))) throw new Error('Expected full base, head, and trusted master SHAs');
  const changed = execFileSync('git', ['--no-replace-objects', 'diff', '--name-only', `${base}...${head}`, '--', 'pnpm-lock.yaml'], { encoding: 'utf8' }).trim();
  return !changed || trustedMergeFiles(base, head, trusted, ['pnpm-lock.yaml']).length === 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--origin') {
  try {
    if (!checkMergedLockfile(...process.argv.slice(3))) throw new Error('Lockfile changes must be unchanged bytes from an actual trusted master merge parent. Use the refresh workflow for dependency updates.');
    console.log('Lockfile unchanged or inherited from a trusted master merge.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(files, process.env.PR_AUTHOR ?? '', process.env.PR_BRANCH ?? '');
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}

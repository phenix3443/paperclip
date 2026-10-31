#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIRECTORY = 'packages/db/src/migrations/';
const MIGRATION_FILE_PATTERN = /^packages\/db\/src\/migrations\/(\d{4})_[^/]+\.sql$/;

function parseMigration(file) {
  const match = file.match(MIGRATION_FILE_PATTERN);
  return match ? { file, number: Number.parseInt(match[1], 10) } : null;
}

function formatMigrationNumber(number) {
  return String(number).padStart(4, '0');
}

export function checkMigrationOrder(baseMigrationFiles, prMigrationFiles, exemptFiles = []) {
  const invalidFiles = [...baseMigrationFiles, ...prMigrationFiles]
    .filter((file) => !parseMigration(file));

  if (invalidFiles.length > 0) {
    return {
      passed: false,
      message: [
        'Migration SQL files must start with a 4-digit number:',
        ...invalidFiles.map((file) => `- ${file}`),
      ].join('\n'),
    };
  }

  if (prMigrationFiles.length === 0) {
    return { passed: true, message: 'No new migrations in this PR.' };
  }

  const baseMigrations = [...baseMigrationFiles, ...exemptFiles].map(parseMigration);
  const prMigrations = prMigrationFiles.filter((file) => !exemptFiles.includes(file)).map(parseMigration);
  const latestBaseMigration = baseMigrations.reduce(
    (latest, migration) => migration.number > latest.number ? migration : latest,
    { file: '(none)', number: -1 },
  );
  const outOfOrder = prMigrations.filter(
    (migration) => migration.number <= latestBaseMigration.number,
  );

  if (outOfOrder.length === 0) {
    return {
      passed: true,
      message: `All new migrations follow ${latestBaseMigration.file}.`,
    };
  }

  const nextNumber = formatMigrationNumber(latestBaseMigration.number + 1);
  return {
    passed: false,
    message: [
      `The target branch already contains migrations through ${latestBaseMigration.file}.`,
      'This PR adds migration numbers that would be inserted into or collide with that history:',
      ...outOfOrder.map((migration) => `- ${migration.file}`),
      '',
      `Update from the target branch, then renumber this PR's migrations starting at ${nextNumber}`,
      'in their intended order. Keep each SQL filename, matching meta snapshot, and',
      'packages/db/src/migrations/meta/_journal.json entry aligned, then push again.',
      'Migration numbers are append-only and cannot reuse a number already present on the target branch.',
    ].join('\n'),
  };
}

function gitPaths(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function escapeWorkflowCommand(message) {
  return message
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

function git(args) {
  return execFileSync('git', ['--no-replace-objects', ...args], { encoding: 'utf8' }).trim();
}

export function trustedMergeFiles(baseSha, headSha, trustedSha, files) {
  if (git(['rev-parse', '--is-shallow-repository']) !== 'false') {
    throw new Error('Incomplete history: fetch full base, head, and trusted master history.');
  }
  for (const sha of [baseSha, headSha, trustedSha]) {
    git(['cat-file', '-e', `${sha}^{commit}`]);
  }
  const merges = git(['rev-list', '--min-parents=2', '--parents', `${baseSha}..${headSha}`]);
  const parents = new Set(merges.split('\n').filter(Boolean).flatMap((line) => line.split(' ').slice(2)));
  const trustedParents = [];
  for (const parent of parents) {
    try {
      git(['merge-base', '--is-ancestor', parent, trustedSha]);
      trustedParents.push(parent);
    } catch (error) {
      if (error.status !== 1) throw error;
    }
  }
  const blob = (sha, file) => {
    const entry = git(['ls-tree', sha, '--', file]);
    const match = entry.match(/^100(?:644|755) blob ([0-9a-f]{40})\t/);
    if (!match) return null;
    git(['cat-file', '-e', match[1]]);
    return match[1];
  };
  return files.filter((file) => {
    const headBlob = blob(headSha, file);
    return headBlob && trustedParents.some((parent) => blob(parent, file) === headBlob);
  });
}

function main() {
  const [baseSha, headSha, trustedSha] = process.argv.slice(2);
  const shaPattern = /^[0-9a-f]{40}$/i;
  if (![baseSha, headSha, trustedSha].every((sha) => shaPattern.test(sha ?? ''))) {
    console.error('Usage: check-pr-migration-order.mjs <40-character base SHA> <40-character head SHA> <trusted master SHA fetched by CI>');
    process.exit(2);
  }

  let result;
  try {
    const baseMigrationFiles = gitPaths([
      'ls-tree', '-r', '--name-only', '-z', baseSha, '--', MIGRATIONS_DIRECTORY,
    ]).filter((file) => file.endsWith('.sql'));
    const prMigrationFiles = gitPaths([
      'diff', '--name-only', '--diff-filter=A', '-z', `${baseSha}...${headSha}`, '--',
      MIGRATIONS_DIRECTORY,
    ]).filter((file) => file.endsWith('.sql'));
    const exemptFiles = trustedMergeFiles(baseSha, headSha, trustedSha, prMigrationFiles);
    result = checkMigrationOrder(baseMigrationFiles, prMigrationFiles, exemptFiles);
  } catch (error) {
    result = { passed: false, message: `Cannot prove migration origin. Fetch complete trusted master, base, and head objects. ${error.message}` };
  }

  if (result.passed) {
    console.log(result.message);
    return;
  }

  console.error(
    `::error title=Migration numbers must follow the target branch::${escapeWorkflowCommand(result.message)}`,
  );
  console.error(result.message);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

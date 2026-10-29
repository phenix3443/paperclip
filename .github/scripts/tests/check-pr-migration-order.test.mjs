import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMigrationOrder } from '../check-pr-migration-order.mjs';

const migration = (name) => `packages/db/src/migrations/${name}.sql`;

test('passes when a PR has no new migrations', () => {
  const result = checkMigrationOrder([migration('0230_on_master')], []);

  assert.equal(result.passed, true);
});

test('passes when every PR migration follows the target branch', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0231_first_in_pr'), migration('0232_second_in_pr')],
  );

  assert.equal(result.passed, true);
});

test('fails with renumbering guidance when a PR reuses the target branch number', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0230_from_stale_branch')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /already contains migrations through .*0230_on_master\.sql/);
  assert.match(result.message, /renumber this PR's migrations starting at 0231/);
  assert.match(result.message, /meta\/_journal\.json/);
});

test('fails when a PR inserts a migration before the target branch tip', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0229_from_stale_branch'), migration('0231_valid_but_after_stale')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /0229_from_stale_branch\.sql/);
  assert.doesNotMatch(result.message, /- packages\/db\/src\/migrations\/0231_valid_but_after_stale\.sql/);
});

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const script = resolve('.github/scripts/check-pr-migration-order.mjs');

function history(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'migration-order-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'root');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const add = (name, sql = 'SELECT 1;') => {
    const file = join(cwd, migration(name));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, sql);
    git('add', '.');
  };
  const commit = () => { git('commit', '--allow-empty', '-m', 'fixture'); return git('rev-parse', 'HEAD'); };
  add('0001_root');
  commit();
  git('checkout', '-b', 'mirror');
  add('0002_upstream');
  add('0004_upstream');
  const trusted = commit();
  git('checkout', '-b', 'feature-parent');
  add('0002_untrusted');
  const untrusted = commit();
  git('checkout', '-b', 'develop', 'root');
  add('0003_fork');
  const base = commit();
  const run = (trust = trusted, head = git('rev-parse', 'HEAD')) => spawnSync(process.execPath, [script, base, head, ...(trust ? [trust] : [])], { cwd, encoding: 'utf8' });
  return { cwd, git, add, commit, trusted, untrusted, base, run };
}

test('CLI accepts unchanged upstream migrations from a real trusted merge', (t) => {
  const h = history(t);
  h.git('merge', '--no-ff', 'mirror', '-m', 'upstream merge');
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, change] of [
  ['changed bytes at the same path', (h) => h.add('0002_upstream', 'SELECT 2;')],
  ['same bytes at a different path', (h) => h.add('0002_copy')],
  ['fork migration below the exempt maximum', (h) => h.add('0004_local')],
  ['fork migration below the base maximum', (h) => h.add('0003_local')],
]) {
  test(`CLI rejects ${name}`, (t) => {
    const h = history(t);
    h.git('merge', '--no-ff', 'mirror', '-m', 'upstream merge');
    change(h);
    h.commit();
    const result = h.run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /renumber this PR's migrations starting at 0005/);
  });
}

test('CLI accepts fork migrations above both base and exempt migrations', (t) => {
  const h = history(t);
  h.git('merge', '--no-ff', 'mirror', '-m', 'upstream merge');
  h.add('0005_local');
  h.commit();
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
});

test('CLI rejects a non-mirror merge parent despite a PR-controlled master ref', (t) => {
  const h = history(t);
  h.git('branch', 'master', h.untrusted);
  h.git('update-ref', 'refs/paperclip-ci/trusted-master', h.untrusted);
  h.git('merge', '--no-ff', 'feature-parent', '-m', 'feature merge');
  const result = h.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /0002_untrusted/);
});

test('CLI rejects a feature PR with copied upstream files but no merge', (t) => {
  const h = history(t);
  h.add('0002_upstream');
  h.commit();
  assert.equal(h.run().status, 1);
});

test('CLI rejects missing or symbolic trusted evidence', (t) => {
  const h = history(t);
  for (const trust of [null, 'master', 'f'.repeat(40)]) {
    const result = h.run(trust);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /trusted master/);
  }
});

test('CLI rejects shallow history even if visible objects match', (t) => {
  const h = history(t);
  h.git('merge', '--no-ff', 'mirror', '-m', 'upstream merge');
  const shallow = join(h.cwd, 'shallow-copy');
  h.git('clone', '--depth=1', `file://${h.cwd}`, shallow);
  const result = spawnSync(process.execPath, [script, h.base, h.git('rev-parse', 'HEAD'), h.trusted], { cwd: shallow, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot prove migration origin/);
});

test('CLI rejects a missing trusted migration blob', (t) => {
  const h = history(t);
  h.git('merge', '--no-ff', 'mirror', '-m', 'upstream merge');
  const blob = h.git('rev-parse', `${h.trusted}:${migration('0002_upstream')}`);
  rmSync(join(h.cwd, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const result = h.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot prove migration origin/);
});


test('CI fetch replaces a PR-controlled ref using the base repository master', (t) => {
  const h = history(t);
  const workflow = readFileSync(resolve('.github/workflows/pr-trusted.yml'), 'utf8');
  const step = workflow.split('      - name: Fetch trusted migration mirror\n')[1].split('\n      - name:')[0];
  assert.match(step, /MIRROR_URL: https:\/\/github.com\/\$\{\{ github.repository \}\}.git/);
  assert.match(workflow, /"\$\{\{ steps.migration-mirror.outputs.sha \}\}"/);
  const command = step.split('        run: |\n')[1].split('\n').map((line) => line.slice(10)).join('\n');
  const remote = join(h.cwd, 'remote.git');
  h.git('clone', '--bare', h.cwd, remote);
  h.git('--git-dir', remote, 'update-ref', 'refs/heads/master', h.trusted);
  h.git('update-ref', 'refs/paperclip-ci/trusted-master', h.untrusted);
  const output = join(h.cwd, 'github-output');
  const result = spawnSync('bash', ['-e', '-c', command], {
    cwd: h.cwd, encoding: 'utf8',
    env: { ...process.env, MIRROR_URL: remote, GITHUB_OUTPUT: output },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, 'utf8').trim(), `sha=${h.trusted}`);
  const missing = spawnSync('bash', ['-e', '-c', command], {
    cwd: h.cwd, encoding: 'utf8',
    env: { ...process.env, MIRROR_URL: join(h.cwd, 'missing.git'), GITHUB_OUTPUT: output },
  });
  assert.notEqual(missing.status, 0);
});

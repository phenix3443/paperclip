import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../..');
const files = [
  'scripts/check-node-version-policy.mjs', 'scripts/node-image-policy.mjs', '.nvmrc',
  'packages/shared/src/node-version.ts', 'scripts/install.sh',
  'docker/agent-runtime/Dockerfile.base', 'packages/adapter-utils/src/sandbox-install-command.ts',
  'packages/plugins/sandbox-providers/exe-dev/src/plugin.ts',
  'packages/plugins/sandbox-providers/modal/src/manifest.ts', 'cli/esbuild.config.mjs',
  'packages/plugins/sdk/src/bundlers.ts', 'scripts/generate-npm-package-json.mjs',
];

test('Node policy permits only the fixed diagnostic pins while checking other workflows', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'diagnostic-node-policy-'));
  try {
    for (const file of files) {
      const target = path.join(fixture, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(repo, file), target);
    }
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ engines: { node: '>=24.11.0' } }));
    const workflows = path.join(fixture, '.github/workflows');
    mkdirSync(workflows, { recursive: true });
    const writeWorkflow = (name, version) => writeFileSync(path.join(workflows, name),
      `jobs:\n  check:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${version}\n`);
    for (const name of ['ci-merge-tree-check.yml', 'ci-merge-tree-comparison.yml']) writeWorkflow(name, '24.11.0');
    writeWorkflow('ordinary.yml', '24');
    const check = () => spawnSync(process.execPath, ['scripts/check-node-version-policy.mjs'], {
      cwd: fixture, encoding: 'utf8', timeout: 10_000,
    });
    let result = check();
    assert.equal(result.status, 0, result.stderr);
    writeWorkflow('ordinary.yml', '24.11.0');
    result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ordinary.yml: node-version must be 24/);
    writeWorkflow('ordinary.yml', '24');
    for (const name of ['ci-merge-tree-check.yml', 'ci-merge-tree-comparison.yml']) {
      writeWorkflow(name, '24.12.0');
      result = check();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /node-version must be 24, found 24.12.0/);
      writeWorkflow(name, '24.11.0');
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

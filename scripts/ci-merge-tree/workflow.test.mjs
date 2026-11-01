import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const yamlRoot = process.env.PAPERCLIP_DIAGNOSTIC_YAML_ROOT ?? path.resolve(import.meta.dirname, '../../node_modules/yaml');
test('diagnostic workflow has only the fixed four-row manual comparison and sealed seven-day upload', {
  skip: !existsSync(path.join(yamlRoot, 'dist/index.js')),
}, async () => {
  const { parse } = await import(pathToFileURL(path.join(yamlRoot, 'dist/index.js')));
  const workflow = parse(readFileSync(new URL('../../.github/workflows/ci-merge-tree-comparison.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(workflow.jobs), ['compare']);
  const job = workflow.jobs.compare;
  assert.equal(job['timeout-minutes'], 25); assert.equal(job.strategy['max-parallel'], 1);
  assert.equal(job.strategy['fail-fast'], false); assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.deepEqual(job.strategy.matrix.include.map(row => `${row.arm}/${row.lane}`), ['base/chat','merge/chat','base/e2e','merge/e2e']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.match(job.if, /github.run_attempt == 1/); assert.match(job.if, /phenix3443\/paperclip/);
  for (const step of job.steps.filter(step => step.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/);
  const upload = job.steps.find(step => step.id === 'upload');
  assert.equal(upload.with['retention-days'], 7);
  assert.match(upload.if, /always\(\).*steps.seal.outcome.*steps.fallback.outcome/);
  assert.equal(upload.with.path, '${{ runner.temp }}/ci-merge-tree/sanitized/');
});

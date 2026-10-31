import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maintenanceProvenance } from '../maintenance-package-provenance.mjs';

const sha = 'a'.repeat(40);
const repository = { id: 1420915320, full_name: 'phenix3443/paperclip' };
const ref = 'refs/heads/fix/maintenance-rework-151';
const path = '.github/workflows/deploy-packages.yml';
function fixture() {
  return {
    context: { repository: repository.full_name, repository_id: String(repository.id), event_name: 'push', ref, ref_protected: true, sha, workflow_ref: `${repository.full_name}/${path}@${ref}`, workflow_sha: sha, run_id: '100', run_attempt: '2' },
    event: { repository, ref, after: sha, deleted: false },
    run: { id: 100, run_attempt: 2, event: 'push', head_sha: sha, head_branch: 'fix/maintenance-rework-151', path, workflow_id: 200, repository, head_repository: repository },
    workflow: { id: 200, path },
    branch: { protected: true, commit: { sha } },
    jobs: [{ id: 300, run_id: 100, head_sha: sha, name: 'packages', status: 'in_progress' }],
  };
}

test('binds maintenance manifest provenance to a trusted push and exact attempt', () => {
  const result = maintenanceProvenance(fixture());
  assert.deepEqual(result, {
    version: 1, repository: repository.full_name, repositoryId: repository.id,
    headRepositoryId: repository.id, ref, sha, workflowPath: path,
    workflowSha: sha, workflowId: 200, runId: 100, runAttempt: 2, jobId: 300,
  });
});

const contradictions = {
  'foreign context repository': f => { f.context.repository = 'other/paperclip'; },
  'wrong numeric repository ID': f => { f.context.repository_id = '42'; },
  'pull request event': f => { f.context.event_name = 'pull_request'; },
  'privileged pull request event': f => { f.context.event_name = 'pull_request_target'; },
  'manual dispatch': f => { f.context.event_name = 'workflow_dispatch'; },
  'workflow run': f => { f.context.event_name = 'workflow_run'; },
  'tag': f => { f.context.ref = 'refs/tags/fix/maintenance-rework-151'; },
  'near-match branch': f => { f.context.ref += '-other'; },
  'unprotected context': f => { f.context.ref_protected = false; },
  'short SHA': f => { f.context.sha = 'aaaaaaa'; },
  'moving workflow source': f => { f.context.workflow_ref = `${repository.full_name}/${path}@refs/heads/develop`; },
  'different workflow revision': f => { f.context.workflow_sha = 'b'.repeat(40); },
  'malformed run ID': f => { f.context.run_id = '100x'; },
  'missing attempt': f => { delete f.context.run_attempt; },
  'foreign event repository': f => { f.event.repository = { ...repository, id: 42 }; },
  'different event SHA': f => { f.event.after = 'b'.repeat(40); },
  'deleted push': f => { f.event.deleted = true; },
  'different event ref': f => { f.event.ref = 'refs/heads/develop'; },
  'foreign run repository': f => { f.run.repository = { ...repository, id: 42 }; },
  'foreign head repository': f => { f.run.head_repository = { ...repository, id: 42 }; },
  'missing head repository': f => { delete f.run.head_repository; },
  'wrong run ID': f => { f.run.id = 99; },
  'rerun attempt': f => { f.run.run_attempt = 3; },
  'contradictory API event': f => { f.run.event = 'workflow_dispatch'; },
  'contradictory API SHA': f => { f.run.head_sha = 'b'.repeat(40); },
  'contradictory API branch': f => { f.run.head_branch = 'develop'; },
  'wrong workflow path': f => { f.run.path = '.github/workflows/pr.yml'; },
  'wrong resolved workflow path': f => { f.workflow.path = '.github/workflows/pr.yml'; },
  'wrong workflow ID': f => { f.workflow.id = 201; },
  'unprotected API branch': f => { f.branch.protected = false; },
  'tip drift': f => { f.branch.commit.sha = 'b'.repeat(40); },
  'missing job': f => { f.jobs = []; },
  'ambiguous job': f => { f.jobs.push({ ...f.jobs[0], id: 301 }); },
  'wrong job run': f => { f.jobs[0].run_id = 99; },
  'wrong job source': f => { f.jobs[0].head_sha = 'b'.repeat(40); },
  'completed job cannot mint provenance': f => { f.jobs[0].status = 'completed'; },
};
for (const [name, mutate] of Object.entries(contradictions)) {
  test(`refuses ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => maintenanceProvenance(f), /Invalid maintenance provenance/);
  });
}

test('workflow pins source/actions and separates PR validation from maintenance packages', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../workflows/deploy-packages.yml', import.meta.url), 'utf8');
  assert.match(source, /branches: \[develop, fix\/maintenance-rework-151\]/);
  assert.match(source, /github\.event_name == 'push' && github\.ref_protected == true/);
  assert.match(source, /github\.repository_id == '1420915320'/);
  assert.match(source, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /pnpm install --frozen-lockfile/);
  assert.match(source, /PAPERCLIP_BUILD_COMMIT="\$SHA"/);
  assert.match(source, /install --repo "\$REPO" --ref "\$SHA"/);
  assert.match(source, /github\.event_name == 'pull_request' && 'paperclip-validation'/);
  assert.match(source, /node \.github\/scripts\/maintenance-package-provenance\.mjs/);
  for (const line of source.split('\n').filter(line => /uses:/.test(line))) {
    assert.match(line, /uses: [\w/-]+@[0-9a-f]{40}(?:\s|$)/);
  }
  assert.doesNotMatch(source, /secrets\.|pull_request_target:|workflow_run:/);
});

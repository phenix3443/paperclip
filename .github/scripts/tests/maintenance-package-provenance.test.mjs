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

test('CLI attaches provenance and refuses contradictory API/manifest evidence without modifying bytes', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const script = new URL('../maintenance-package-provenance.mjs', import.meta.url);
  const f = fixture();
  const contextEnv = {
    GITHUB_REPOSITORY: f.context.repository, GITHUB_REPOSITORY_ID: f.context.repository_id,
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: ref, GITHUB_REF_PROTECTED: 'true',
    GITHUB_SHA: sha, GITHUB_WORKFLOW_REF: f.context.workflow_ref,
    GITHUB_WORKFLOW_SHA: sha, GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '2',
  };
  for (const scenario of ['valid', 'newer attempt', 'truncated jobs', 'API failure', 'wrong manifest', 'existing provenance']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-provenance-'));
    try {
      const manifestPath = path.join(dir, 'payload-packages.json');
      const manifest = { repo: repository.full_name, sha: scenario === 'wrong manifest' ? 'b'.repeat(40) : sha, files: [] };
      if (scenario === 'existing provenance') manifest.ciProvenance = { version: 0 };
      const original = JSON.stringify(manifest);
      fs.writeFileSync(manifestPath, original);
      fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify(f.event));
      const responses = {
        'actions/runs/100/attempts/2': f.run,
        'actions/runs/100': { ...f.run, run_attempt: scenario === 'newer attempt' ? 3 : 2 },
        'actions/workflows/deploy-packages.yml': f.workflow,
        'branches/fix%2Fmaintenance-rework-151': f.branch,
        'actions/runs/100/attempts/2/jobs?per_page=100': { jobs: f.jobs, total_count: scenario === 'truncated jobs' ? 101 : 1 },
      };
      const preload = path.join(dir, 'fetch.mjs');
      fs.writeFileSync(preload, `
        const responses = ${JSON.stringify(responses)};
        globalThis.fetch = async (url, options) => {
          if (options.headers.Authorization !== 'Bearer fixture-token') throw new Error('missing token');
          const prefix = 'https://api.github.com/repos/phenix3443/paperclip/';
          if (!url.startsWith(prefix)) throw new Error('wrong API repository');
          const endpoint = url.slice(prefix.length);
          if (!Object.hasOwn(responses, endpoint)) throw new Error('unexpected endpoint: ' + endpoint);
          return { ok: ${scenario !== 'API failure'}, status: 403, json: async () => responses[endpoint] };
        };
      `);
      const result = spawnSync(process.execPath, ['--import', preload, script.pathname], {
        env: { ...process.env, ...contextEnv, GITHUB_TOKEN: 'fixture-token', GITHUB_EVENT_PATH: path.join(dir, 'event.json'), PACKAGES_DIR: dir },
        encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      if (scenario === 'valid') {
        assert.equal(result.status, 0, result.stderr);
        const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        assert.deepEqual(written.ciProvenance, maintenanceProvenance(f));
        delete written.ciProvenance;
        assert.deepEqual(written, manifest);
      } else {
        assert.equal(result.status, 1, scenario);
        assert.equal(fs.readFileSync(manifestPath, 'utf8'), original, scenario);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});


test('maintenance checks cover the existing selector inventory before packaging', async () => {
  const { readFile } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const source = await readFile(new URL('../../workflows/deploy-packages.yml', import.meta.url), 'utf8');
  const tests = source.match(/^  maintenance_tests:\n([\s\S]*?)(?=^  \w+:)/m)?.[1];
  assert.ok(tests, 'maintenance tests must have an independent job');
  assert.match(tests, /timeout-minutes: 90/);
  assert.match(tests, /max-parallel: 4/);
  assert.match(tests, /fail-fast: false/);
  const matrix = JSON.parse(tests.match(/include: (\[[\s\S]*?\])\n/)?.[1] ?? 'null');
  assert.equal(matrix.length, 29);
  const inventory = (args) => {
    const result = spawnSync(process.execPath, ['scripts/run-vitest-stable.mjs', '--dry-run', ...args],
      { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const all = inventory([]);
  const server = [], serialized = [], projects = [], chat = [];
  const groups = new Map();
  for (const lane of matrix) {
    const args = ['--mode', lane.mode];
    if (lane.group) args.push('--group', lane.group);
    if (lane.shard_count) args.push('--shard-index', String(lane.shard_index), '--shard-count', String(lane.shard_count));
    const selected = inventory(args);
    if (lane.mode === 'serialized') {
      assert.ok(selected.selectedSerializedSuites.length > 0, lane.label);
      serialized.push(...selected.selectedSerializedSuites);
    } else {
      const lanes = groups.get(lane.group) ?? [];
      lanes.push(lane); groups.set(lane.group, lanes);
      if (selected.selectedGeneralServerSuites) {
        assert.ok(selected.selectedGeneralServerSuites.length > 0, lane.label);
        server.push(...selected.selectedGeneralServerSuites);
      }
      if (selected.workspaceProjects) projects.push(...selected.workspaceProjects);
      if (selected.chatVitestShards) chat.push(...selected.chatVitestShards);
    }
  }
  assert.equal(new Set(server).size, server.length, 'server suites must not overlap');
  const fullServer = inventory(['--mode', 'general', '--group', 'general-server', '--shard-index', '0', '--shard-count', '1']);
  assert.deepEqual([...server, 'server/src/__tests__/chat-channels.integration.test.ts'].sort(),
    fullServer.selectedGeneralServerSuites.sort());
  assert.equal(new Set(serialized).size, serialized.length, 'serialized suites must not overlap');
  assert.deepEqual(serialized.sort(), all.selectedSerializedSuites.sort());
  assert.deepEqual([...groups.keys()].sort(), [
    'general-server-without-chat-or-native-runner', 'general-chat', 'general-server-native-runner',
    'general-workspaces-a', 'general-workspaces-b', 'general-workspaces-c',
  ].sort());
  for (const [group, lanes] of groups) {
    const count = lanes[0].shard_count || 1;
    assert.equal(lanes.length, count, group);
    assert.deepEqual(lanes.map(lane => lane.shard_index || 0).sort((a, b) => a - b),
      Array.from({ length: count }, (_, index) => index), group);
    assert.ok(lanes.every(lane => (lane.shard_count || 1) === count), group);
  }
  assert.deepEqual(chat.map(shard => shard.index).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.ok(chat.every(shard => shard.count === 6));
  const workspaces = ['general-workspaces-a', 'general-workspaces-b', 'general-workspaces-c']
    .flatMap(group => inventory(['--mode', 'general', '--group', group]).workspaceProjects);
  assert.deepEqual([...new Set(projects)].sort(), workspaces.sort());
  assert.match(tests, /node scripts\/run-vitest-stable\.mjs --mode "\$MODE"/);
  assert.match(tests, /--shard-index "\$SHARD_INDEX" --shard-count "\$SHARD_COUNT"/);
});

test('package admission rejects failed, cancelled or skipped maintenance prerequisites', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../../workflows/deploy-packages.yml', import.meta.url), 'utf8');
  const job = source.match(/^  packages:\n([\s\S]*?)(?:    permissions:)/m)?.[1];
  assert.match(job ?? '', /needs: \[maintenance_build, maintenance_tests\]/);
  const expression = job.match(/if: >-\n([\s\S]*)/)?.[1].trim();
  const admitted = (build, tests, context = {}) => runInNewContext(expression, {
    always: () => true,
    github: { repository: 'phenix3443/paperclip', repository_id: '1420915320',
      ref: 'refs/heads/fix/maintenance-rework-151', base_ref: '', event_name: 'push',
      ref_protected: true, ...context },
    needs: { maintenance_build: { result: build }, maintenance_tests: { result: tests } },
  });
  assert.equal(admitted('success', 'success'), true);
  for (const result of ['failure', 'cancelled', 'skipped', '']) {
    assert.equal(admitted(result, 'success'), false, result);
    assert.equal(admitted('success', result), false, result);
  }
  assert.equal(admitted('success', 'success', { ref_protected: false }), false);
  assert.equal(admitted('success', 'success', { event_name: 'workflow_dispatch' }), false);
  assert.equal(admitted('success', 'success', { repository: 'other/paperclip' }), false);
  const pr = { event_name: 'pull_request', ref: 'refs/pull/310/merge', base_ref: 'fix/maintenance-rework-151' };
  assert.equal(admitted('success', 'success', pr), true);
  assert.equal(admitted('skipped', 'success', pr), false);
  assert.equal(admitted('skipped', 'skipped', { ref: 'refs/heads/develop' }), true);
});

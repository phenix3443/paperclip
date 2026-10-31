import { boundedProcess } from './process-tree.mjs';
import { isolatedCommand } from './namespace.mjs';
import { runPhase } from './phase.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE, HEAD, SPECS, fixedRow, validateDispatch, verifySource } from './identity.mjs';

const control = path.dirname(fileURLToPath(import.meta.url));
const [arm, lane, source, output, started] = process.argv.slice(2);
const row = fixedRow(arm, lane);
const sourceRoot = realpathSync(source);
const outputRoot = existsSync(output) ? realpathSync(output) : path.join(realpathSync(path.dirname(output)), path.basename(output));
if (!path.isAbsolute(output) || outputRoot === sourceRoot || outputRoot.startsWith(`${sourceRoot}${path.sep}`)) throw new Error('evidence_root_must_be_external');
const privateRoot = path.join(output, 'private');
const stage = path.join(output, 'sanitized');
mkdirSync(privateRoot, { recursive: true, mode: 0o700 }); mkdirSync(stage, { recursive: true });
const json = (name, value) => writeFileSync(path.join(stage, name), JSON.stringify(value, null, 2));
const status = { schema: 1, row, phases: [], evidence: 'incomplete', result: 'not_started' };
const checkpoint = () => json('status.json', status);
const endAt = Number(started) + 20 * 60 * 1000;
const env = {
  PATH: process.env.PATH, HOME: path.join(privateRoot, 'home'), TMPDIR: path.join(privateRoot, 'tmp'),
  CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW: 'PR', NODE_ENV: 'test', PNPM_HOME: process.env.PNPM_HOME ?? '',
  npm_config_store_dir: path.join(privateRoot, 'pnpm-store'),
  TURBO_TELEMETRY_DISABLED: '1', PAPERCLIP_TELEMETRY_ENABLED: 'false',
  PAPERCLIP_FIXED_CI_PRIVATE: privateRoot, PAPERCLIP_FIXED_CI_SOURCE: source,
  PAPERCLIP_FIXED_CI_DEADLINE: String(endAt),
  PAPERCLIP_FIXED_CI_CONTEXT: path.join(privateRoot, 'context.json'),
};
for (const dir of [env.HOME, env.TMPDIR]) mkdirSync(dir, { recursive: true, mode: 0o700 });
checkpoint();

async function phase(name, command, args, childEnv = env, cwd = source) {
  const result = await runPhase({ name, command, args, env: childEnv, cwd, deadline: endAt,
    privateRoot, stage, onChange(entry) {
      if (!status.phases.includes(entry)) status.phases.push(entry);
      checkpoint();
    } });
  return result.status === 'passed';
}

let gaps = [];
try {
  validateDispatch({ repository: process.env.GITHUB_REPOSITORY, attempt: process.env.GITHUB_RUN_ATTEMPT,
    ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, expectedSha: process.env.EXPECTED_CONTROL_SHA,
    executionKey: process.env.EXECUTION_KEY });
  const expected = { sha: row.sha, ...(arm === 'merge' ? { parents: [BASE, HEAD] } : {}) };
  const identities = { before: verifySource(source, expected) }; json('identity.json', identities);
  const version = (command, args) => {
    try { return execFileSync(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).toString().trim(); }
    catch { return 'unavailable'; }
  };
  const environment = { node: process.version, pnpm: version('pnpm', ['--version']),
    chrome: version('google-chrome', ['--version']), postgresClient: version('psql', ['--version']),
    os: os.release(), arch: os.arch(), cpus: os.cpus().length,
    imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion,
    allowlistedChildEnvironment: env };
  json('environment.json', environment);
  const files = readdirSync(control).filter(name => /\.(?:mjs|py|json)$/.test(name) && !name.includes('.test.')).sort();
  const hashes = files.map(name => ({ name, sha256: createHash('sha256').update(readFileSync(path.join(control, name))).digest('hex') }));
  json('instrumentation.json', { controlSha: process.env.GITHUB_SHA, files: hashes,
    digest: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),
    overrides: ['cold frozen install; no cache', 'external driver observer before cleanup/close',
      'external test reporters', 'E2E trace=on retries=0', 'all test egress disabled with private network namespace',
      'unknown log text and trace payloads excluded', 'source chat runner /tmp fixture roots bind-mounted into private job temp'],
    uploadRetentionDays: 7, uploadCapBytes: 100 * 1024 * 1024 });
  const commands = [
    ['pnpm', 'install', '--frozen-lockfile'],
    ['pnpm', 'run', 'preflight:workspace-links'],
    ['node', 'scripts/ensure-plugin-build-deps.mjs'],
  ];
  json('commands.json', { setup: commands, chat: { command: ['node', 'scripts/ci/run-task.mjs'], env: { CI_TASK: 'ci:chat', CI_TASK_ARGS: '[\"--shard-index\",\"2\",\"--shard-count\",\"3\"]', CI_FORCE_TASKS: 'true' } }, e2e: ['pnpm', 'run', 'test:e2e', ...SPECS, '--trace=on', '--retries=0', '--output=<private>/results', '--reporter=list,<control>/playwright-reporter.mjs'] });
  for (const [command, ...args] of commands) {
    if (!await phase(command === 'pnpm' && args[0] === 'install' ? 'install' : 'build_dependencies', command, args)) {
      status.result = 'setup_dependency_failure'; throw new Error('phase_failed');
    }
  }
  environment.dependencies = readdirSync(path.join(source, 'node_modules/.pnpm')).flatMap(name => {
    const match = name.match(/^(postgres|embedded-postgres|vitest|@playwright\+test|playwright-core|turbo)@([0-9][A-Za-z0-9.+-]*)(?:_|$)/);
    return match ? [{ name: match[1].replace('+', '/'), version: match[2] }] : [];
  });
  json('environment.json', environment);
  identities.afterSetup = verifySource(source, expected); json('identity.json', identities);
  if (lane === 'chat' && !await phase('selection', 'node', ['scripts/run-vitest-stable.mjs', '--mode', 'general', '--group', 'general-chat', '--shard-index', '2', '--shard-count', '3', '--dry-run'])) {
    status.result = 'setup_selection_failure'; throw new Error('phase_failed');
  }
  const testEnv = { ...env, NODE_OPTIONS: `--import=${pathToFileURL(path.join(control, 'preload.mjs')).href}` };
  const uid = os.userInfo();
  const namespace = { env: testEnv, source, uid: uid.uid, gid: uid.gid,
    seconds: Math.max(1, Math.floor((endAt - Date.now()) / 1000)) };
  const args = isolatedCommand({ ...namespace, command: process.execPath,
    args: [path.join(control, 'lane.mjs'), lane, source, privateRoot] });
  const probeArgs = isolatedCommand({ ...namespace, command: '/usr/bin/true', args: [] });
  if (!await phase('isolation', 'sudo', probeArgs, { PATH: process.env.PATH }, source)) {
    status.result = 'setup_isolation_failure'; throw new Error('phase_failed');
  }
  const passed = await phase('test', 'sudo', args, { PATH: process.env.PATH }, source);
  let serverStages = [];
  if (existsSync(path.join(privateRoot, 'webserver-status.json'))) {
    serverStages = JSON.parse(readFileSync(path.join(privateRoot, 'webserver-status.json'), 'utf8'));
    status.phases.push(...serverStages);
  }
  const events = existsSync(path.join(privateRoot, 'cases.jsonl')) ? readFileSync(path.join(privateRoot, 'cases.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  status.result = serverStages.some(entry => entry.name === 'ui_build' && entry.status !== 'passed') ? 'setup_build_failure'
    : events.some(event => event.kind === 'global_error') ? 'setup_or_infrastructure_failure'
    : lane === 'e2e' && (!serverStages.length || !events.some(event => event.kind === 'start')) ? 'setup_webserver_failure'
    : passed ? 'passed' : status.phases.find(entry => entry.name === 'test')?.status === 'timed_out' ? 'timed_out' : 'test_failure';
  identities.afterTest = verifySource(source, expected); json('identity.json', identities);
} catch (error) {
  if (/source_(?:identity|integrity)/.test(error.message ?? '')) status.result = 'source_integrity_failure';
  else if (status.result === 'not_started') status.result = 'setup_or_integrity_failure';
  gaps.push({ kind: 'phase_incomplete' });
} finally {
  checkpoint();
  const budget = Math.min(120000, Number(started) + 22 * 60 * 1000 - Date.now());
  try {
    if (budget <= 0) throw new Error('packaging_deadline');
    await boundedProcess(process.execPath, [path.join(control, 'finalize.mjs'), output], {
      env: { PATH: process.env.PATH }, deadline: Date.now() + budget,
    });
    Object.assign(status, JSON.parse(readFileSync(path.join(stage, 'status.json'), 'utf8')));
  } catch {
    status.evidence = 'incomplete'; status.packaging = 'failed_or_timed_out';
    checkpoint(); json('capture-gaps.json', [{ kind: 'packaging_failure_or_deadline' }]);
  }
}

process.exitCode = status.result === 'passed' && status.evidence !== 'incomplete' ? 0 : 1;

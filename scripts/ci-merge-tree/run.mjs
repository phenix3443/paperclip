import { runPhase } from './phase.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, HEAD, SPECS, fixedRow, validateDispatch, verifySource } from './identity.mjs';
import { sealStage } from './evidence.mjs';

const control = path.dirname(fileURLToPath(import.meta.url));
const [arm, lane, source, output, started] = process.argv.slice(2);
const row = fixedRow(arm, lane);
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
  json('environment.json', { node: process.version, pnpm: version('pnpm', ['--version']),
    chrome: version('google-chrome', ['--version']), postgres: version('psql', ['--version']),
    os: os.release(), arch: os.arch(), cpus: os.cpus().length,
    imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion,
    allowlistedChildEnvironment: env });
  const files = readdirSync(control).filter(name => /\.(?:mjs|py)$/.test(name) && !name.includes('.test.')).sort();
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
  identities.afterSetup = verifySource(source, expected); json('identity.json', identities);
  if (lane === 'chat' && !await phase('selection', 'node', ['scripts/run-vitest-stable.mjs', '--mode', 'general', '--group', 'general-chat', '--shard-index', '2', '--shard-count', '3', '--dry-run'])) {
    status.result = 'setup_selection_failure'; throw new Error('phase_failed');
  }
  const testEnv = { ...env, NODE_OPTIONS: `--import=${path.join(control, 'preload.mjs')}` };
  const uid = os.userInfo();
  const args = ['unshare', '--pid', '--fork', '--kill-child=KILL', '--mount', '--net', '--', '/bin/bash', '-c', 'mount --make-rprivate /; mount --bind "$1" /tmp; shift; ip link set lo up; exec "$@"', '--', env.TMPDIR,
    'setpriv', `--reuid=${uid.uid}`, `--regid=${uid.gid}`, '--init-groups', '/usr/bin/env', '-i',
    ...Object.entries(testEnv).map(([key, value]) => `${key}=${value}`),
    process.execPath, path.join(control, 'lane.mjs'), lane, source, privateRoot];
  const probeArgs = [...args.slice(0, args.indexOf(process.execPath)), '/usr/bin/true'];
  if (!await phase('isolation', 'sudo', probeArgs, { PATH: process.env.PATH }, source)) {
    status.result = 'setup_isolation_failure'; throw new Error('phase_failed');
  }
  const passed = await phase('test', 'sudo', args, { PATH: process.env.PATH }, source);
  status.result = passed ? 'passed' : status.phases.at(-1).status === 'timed_out' ? 'timed_out' : 'test_failure';
  identities.afterTest = verifySource(source, expected); json('identity.json', identities);
} catch (error) {
  if (/source_(?:identity|integrity)/.test(error.message ?? '')) status.result = 'source_integrity_failure';
  else if (status.result === 'not_started') status.result = 'setup_or_integrity_failure';
  gaps.push({ kind: 'phase_incomplete' });
} finally {
  for (const [input, output] of [['projection.jsonl', 'projection.jsonl'], ['cases.jsonl', 'assertions.jsonl']]) {
    if (existsSync(path.join(privateRoot, input))) copyFileSync(path.join(privateRoot, input), path.join(stage, output));
    else gaps.push({ kind: input === 'cases.jsonl' ? 'test_report_missing' : 'fixture_projection_missing' });
  }
  if (existsSync(path.join(privateRoot, 'capture-gaps.jsonl'))) {
    gaps.push(...readFileSync(path.join(privateRoot, 'capture-gaps.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  }
  const resultRoot = path.join(privateRoot, 'results'); mkdirSync(resultRoot, { recursive: true });
  const traceGaps = path.join(privateRoot, 'trace-gaps.json');
  try {
    execFileSync('python3', [path.join(control, 'sanitize-traces.py'), resultRoot, path.join(stage, 'trace.zip'), traceGaps], { stdio: 'pipe', timeout: 30000 });
    gaps.push(...JSON.parse(readFileSync(traceGaps, 'utf8')));
  } catch { gaps.push({ kind: 'trace_sanitization_failure' }); }
  const cases = existsSync(path.join(stage, 'assertions.jsonl')) ? readFileSync(path.join(stage, 'assertions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  json('selection.json', { row, cases }); json('report.json', { status, cases });
  writeFileSync(path.join(stage, 'report.html'), `<pre>${JSON.stringify({ status, cases }, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`);
  json('capture-gaps.json', gaps);
  status.evidence = gaps.some(gap => gap.kind !== 'trace_payloads_removed') ? 'incomplete' : 'available_with_documented_redactions';
  checkpoint();
  try { sealStage(stage); } catch { status.result = 'capture_failure'; checkpoint(); }
}
process.exitCode = status.result === 'passed' && status.evidence !== 'incomplete' ? 0 : 1;

import { spawn } from 'node:child_process';
import path from 'node:path';
import { SPECS } from './identity.mjs';

const [lane, source, output] = process.argv.slice(2);
const env = { ...process.env };
let command; let args;
if (lane === 'chat') {
  command = 'node'; args = ['scripts/ci/run-task.mjs'];
  Object.assign(env, { CI_TASK: 'ci:chat', CI_TASK_ARGS: '["--shard-index","2","--shard-count","3"]', CI_FORCE_TASKS: 'true' });
} else if (lane === 'e2e') {
  command = 'pnpm';
  args = ['run', 'test:e2e', ...SPECS, '--trace=on', '--retries=0', `--output=${path.join(output, 'results')}`,
    `--reporter=list,${new URL('./playwright-reporter.mjs', import.meta.url).pathname}`];
  Object.assign(env, { PAPERCLIP_E2E_SKIP_LLM: 'true', PAPERCLIP_PLAYWRIGHT_CHANNEL: 'chrome' });
} else throw new Error('invalid_lane');
const child = spawn(command, args, { cwd: source, env, stdio: 'inherit' });
child.once('error', () => { process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });

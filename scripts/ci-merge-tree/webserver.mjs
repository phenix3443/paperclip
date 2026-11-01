import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPhase } from './phase.mjs';

export { ORIGINAL_SERVER_COMMAND } from './commands.mjs';

export async function observeWebServer({ source, privateRoot, env, build, server, signal }) {
  const stages = [];
  const stage = path.join(privateRoot, 'service-sanitized'); mkdirSync(stage, { recursive: true });
  const onChange = entry => {
    if (!stages.includes(entry)) stages.push(entry);
    writeFileSync(path.join(privateRoot, 'webserver-status.json'), JSON.stringify(stages));
  };
  const options = { cwd: source, env, privateRoot, stage, onChange, signal,
    deadline: Number(env.PAPERCLIP_FIXED_CI_DEADLINE) };
  const built = await runPhase({ ...options, name: 'ui_build', ...build });
  if (built.status !== 'passed') return built.exit ?? 1;
  const served = await runPhase({ ...options, name: 'webserver_process', ...server });
  return served.exit ?? (signal?.aborted ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort()); process.on('SIGINT', () => controller.abort());
  process.exitCode = await observeWebServer({ source: process.env.PAPERCLIP_FIXED_CI_SOURCE,
    privateRoot: process.env.PAPERCLIP_FIXED_CI_PRIVATE, env: process.env, signal: controller.signal,
    build: { command: 'pnpm', args: ['--filter', '@paperclipai/ui', 'build', '--outDir', '../server/ui-dist', '--emptyOutDir'] },
    server: { command: process.execPath, args: ['cli/node_modules/tsx/dist/cli.mjs', 'cli/src/index.ts', 'onboard', '--yes', '--run'] } });
}

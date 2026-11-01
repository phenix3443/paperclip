import { spawn } from 'node:child_process';

export async function boundedProcess(command, args, { deadline, env, cwd } = {}) {
  if (!(deadline > Date.now())) throw new Error('process_deadline');
  const child = spawn(command, args, { env, cwd, detached: true, stdio: 'ignore' });
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  let expired = false;
  const timer = setTimeout(() => { expired = true; kill(); }, deadline - Date.now());
  const code = await new Promise(resolve => {
    child.once('error', () => resolve(null)); child.once('close', resolve);
  });
  clearTimeout(timer); kill();
  if (expired) throw new Error('process_deadline');
  if (code !== 0) throw new Error('process_failure');
}

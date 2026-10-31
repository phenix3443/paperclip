import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { sourceLocations } from './source-locations.mjs';
import { safeLog } from './evidence.mjs';

export async function runPhase({ name, command, args, env, cwd, deadline, privateRoot, stage, signal, onChange = () => {} }) {
  const sources = sourceLocations(cwd);
  const entry = { name, status: 'running', start: new Date().toISOString(), exit: null, signal: null };
  onChange(entry);
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    Object.assign(entry, { status: 'timed_out', end: new Date().toISOString() }); onChange(entry); return entry;
  }
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let timedOut = false;
  const output = (kind, chunk) => {
    appendFileSync(path.join(privateRoot, `${kind}.raw`), chunk, { mode: 0o600 });
    const safe = safeLog(chunk.toString(), sources.files).split('\n').map(line => JSON.stringify({ phase: name, at: new Date().toISOString(), ...JSON.parse(line) })).join('\n');
    appendFileSync(path.join(stage, `${kind}.jsonl`), `${safe}\n`);
    process.stdout.write(`${safe}\n`);
  };
  child.stdout.on('data', chunk => output('stdout', chunk)); child.stderr.on('data', chunk => output('stderr', chunk));
  const terminate = signal => { try { process.kill(-child.pid, signal); } catch {} };
  let killTimer;
  const abort = () => { terminate('SIGTERM'); killTimer = setTimeout(() => terminate('SIGKILL'), 5000); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => {
    timedOut = true; terminate('SIGTERM');
    killTimer = setTimeout(() => terminate('SIGKILL'), 5000);
  }, remaining);
  const result = await new Promise(resolve => {
    child.once('error', () => resolve({ code: null, signal: null, spawnError: true }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  signal?.removeEventListener('abort', abort);
  clearTimeout(timer); clearTimeout(killTimer); terminate('SIGKILL');
  Object.assign(entry, { exit: result.code, signal: result.signal,
    status: signal?.aborted ? 'cancelled' : timedOut || (command === 'sudo' && args[0] === 'timeout' && result.code === 124) ? 'timed_out' : result.code === 0 ? 'passed' : result.spawnError ? 'setup_failure' : 'failed',
    end: new Date().toISOString() }); onChange(entry);
  return entry;
}


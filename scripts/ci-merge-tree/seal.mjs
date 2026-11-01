import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sealStage } from './evidence.mjs';

const [root, checkout] = process.argv.slice(2);
const write = (name, value) => writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
if (checkout !== 'success') {
  write('status.json', { result: 'source_unavailable', evidence: 'incomplete' });
  write('capture-gaps.json', [{ kind: 'source_checkout_failure' }]);
}
const gapsPath = path.join(root, 'capture-gaps.json');
let gaps = existsSync(gapsPath) ? JSON.parse(readFileSync(gapsPath, 'utf8')) : [{ kind: 'harness_not_completed' }];
write('capture-gaps.json', gaps);
for (const candidate of [null, 'trace.zip', 'report.html', 'projection.jsonl', 'stdout.jsonl', 'stderr.jsonl', 'report.json']) {
  if (candidate && existsSync(path.join(root, candidate))) {
    unlinkSync(path.join(root, candidate)); gaps.push({ kind: 'artifact_cap_omission', file: candidate });
    write('capture-gaps.json', gaps);
    const statusPath = path.join(root, 'status.json');
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    status.evidence = 'incomplete'; write('status.json', status);
  }
  try { sealStage(root); process.exit(0); }
  catch (error) { if (error.message !== 'stage_cap_exceeded') throw error; }
}
throw new Error('artifact_cap_unrecoverable');

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealStage } from './evidence.mjs';

export function finalize(output) {
  const privateRoot = path.join(output, 'private');
  const stage = path.join(output, 'sanitized');
  const control = path.dirname(fileURLToPath(import.meta.url));
  const status = JSON.parse(readFileSync(path.join(stage, 'status.json'), 'utf8'));
  const row = status.row;
  const json = (name, value) => writeFileSync(path.join(stage, name), JSON.stringify(value, null, 2));

  let gaps = status.result === 'passed' || status.result === 'test_failure' ? [] : [{ kind: 'phase_incomplete' }];
  for (const [input, output] of [['database-errors.jsonl', 'database.jsonl'], ['projection.jsonl', 'projection.jsonl'], ['cases.jsonl', 'assertions.jsonl']]) {
    if (existsSync(path.join(privateRoot, input))) copyFileSync(path.join(privateRoot, input), path.join(stage, output));
    else if (input !== 'database-errors.jsonl') gaps.push({ kind: input === 'cases.jsonl' ? 'test_report_missing' : 'fixture_projection_missing' });
  }
  if (existsSync(path.join(privateRoot, 'capture-gaps.jsonl'))) {
    gaps.push(...readFileSync(path.join(privateRoot, 'capture-gaps.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  }
  const resultRoot = path.join(privateRoot, 'results'); mkdirSync(resultRoot, { recursive: true });
  const traceGaps = path.join(privateRoot, 'trace-gaps.json');
  try {
    execFileSync('python3', [path.join(control, 'sanitize-traces.py'), resultRoot, path.join(stage, 'trace.zip'), traceGaps, row.lane], { stdio: 'pipe', timeout: 30000 });
    gaps.push(...JSON.parse(readFileSync(traceGaps, 'utf8')));
  } catch { gaps.push({ kind: 'trace_sanitization_failure' }); }
  for (const kind of ['stdout', 'stderr']) {
    const serviceLog = path.join(privateRoot, 'service-sanitized', `${kind}.jsonl`);
    if (existsSync(serviceLog)) copyFileSync(serviceLog, path.join(stage, `service-${kind}.jsonl`));
  }
  const environmentFile = path.join(stage, 'environment.json');
  if (existsSync(environmentFile) && existsSync(path.join(stage, 'projection.jsonl'))) {
    const environment = JSON.parse(readFileSync(environmentFile, 'utf8'));
    environment.embeddedPostgresVersions = [...new Set(readFileSync(path.join(stage, 'projection.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).databaseVersion).filter(Boolean))];
    json('environment.json', environment);
  }
  const cases = existsSync(path.join(stage, 'assertions.jsonl')) ? readFileSync(path.join(stage, 'assertions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  json('selection.json', { row, cases });
  writeFileSync(path.join(stage, 'report.html'), `<pre>${JSON.stringify({ status, cases }, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`);
  json('capture-gaps.json', gaps);
  status.evidence = gaps.some(gap => gap.kind !== 'trace_payloads_removed') ? 'incomplete' : 'available_with_documented_redactions';
  json('status.json', status); json('report.json', { status, cases });
  try { sealStage(stage); } catch { status.result = 'capture_failure'; json('status.json', status); }

  return status;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) finalize(process.argv[2]);

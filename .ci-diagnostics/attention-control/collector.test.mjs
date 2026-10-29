import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Reporter, { readReport } from './reporter.mjs';

const file = 'server/src/example.test.ts';
const makeModule = (path = file) => ({ moduleId: join('/source', path), state: () => 'passed', errors: () => [], children: { *allTests() { yield { name: 'SECRET title', result: () => ({ state: 'passed', errors: [] }), diagnostic: () => ({ duration: 7 }) }; } } });
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'collector-fixture-'));
  try { return run(join(dir, 'report.json')); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('typed reporter records actual inventory without console, title or error text', () => fixture((path) => {
  const reporter = new Reporter({ root: '/source', files: [file], output: path });
  reporter.onTestRunEnd([makeModule()], [], 'passed');
  const result = readReport(path, [file]);
  assert.equal(result.code, 'complete');
  assert.deepEqual(result.report.modules, [{ file, status: 'passed', failure: null, tests: [{ index: 0, status: 'passed', duration: 7, failure: null }] }]);
  assert.ok(!readFileSync(path, 'utf8').includes('SECRET'));
}));
test('collector distinguishes missing, malformed and wrong inventory without echoing payloads', () => fixture((path) => {
  assert.equal(readReport(path, [file]).code, 'report-missing');
  writeFileSync(path, 'SECRET invalid json');
  assert.equal(readReport(path, [file]).code, 'report-parse-failed');
  const reporter = new Reporter({ root: '/source', files: [file], output: path });
  reporter.onTestRunEnd([makeModule(), makeModule()], [], 'passed');
  assert.equal(readReport(path, [file]).code, 'inventory-mismatch');
  reporter.onTestRunEnd([], [], 'passed');
  assert.equal(readReport(path, [file]).code, 'inventory-mismatch');
  const bad = makeModule();bad.state = () => 'pending';
  reporter.onTestRunEnd([bad], [], 'passed');
  assert.equal(readReport(path, [file]).code, 'invalid-structure');
  bad.state = () => { throw Error('SECRET'); };
  reporter.onTestRunEnd([bad], [], 'passed');
  assert.equal(readReport(path, [file]).code, 'projection-failed');
  assert.ok(!readFileSync(path, 'utf8').includes('SECRET'));
}));
test('failed hook and unhandled errors are classified without serializing messages', () => fixture((path) => {
  const module = makeModule(); module.state = () => 'failed'; module.errors = () => [{ message: 'Hook timed out in 30000ms SECRET' }];
  new Reporter({ root: '/source', files: [file], output: path }).onTestRunEnd([module], [Error('SECRET')], 'failed');
  const { report } = readReport(path, [file]);
  assert.equal(report.unhandledErrors, 1);
  assert.equal(report.modules[0].failure, 'hook-timeout-30000ms');
  assert.ok(!readFileSync(path, 'utf8').includes('SECRET'));
}));
import { validateSnapshot } from './snapshot.mjs';
const row = (pid, blockers = []) => ({ pid, state: 'active', wait_event_type: null, wait_event: null, blockers, lockGroupTotal: 1, lockGroups: [{ locktype: 'advisory', mode: 'ExclusiveLock', granted: true, count: 251 }] });
test('aggregated locks retain all PIDs and prove blocker coverage', () => {
  const snapshot = validateSnapshot({ total: 2, records: [row(101, [102]), row(102)] });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.records[0].lockGroups[0].count, 251);
  assert.equal(snapshot.returned, 2);
  assert.equal(validateSnapshot({ total: 2, records: [row(101, [102])] }).complete, false);
  assert.equal(validateSnapshot({ total: 1, records: [{ ...row(101), lockGroupTotal: 2 }] }).complete, false);
  assert.throws(() => validateSnapshot({ total: 1, records: [{ ...row(101), query: 'SECRET' }] }));
});
import { observeCleanup } from './observe-cleanup.mjs';
test('observer preserves delete error and closes the client once on repeated cleanup', async () => {
  let ends = 0;
  const events = [];const old = console.log;console.log = (...args) => events.push(args[1]);
  try {
    const observer = observeCleanup(() => ({ reserve: async () => ({ unsafe: async (sql) => sql === 'show server_version' ? [{ server_version: '18.1' }] : [] }), end: async () => { ends++; } }));
    const original = Error('SECRET');
    await assert.rejects(observer.run('heartbeatRuns', async () => { throw original; }), (error) => error === original);
    await observer.close();await observer.close();
    assert.equal(ends, 1);
    assert.ok(events.some((line) => JSON.parse(line).event === 'delete-end'));
    assert.ok(!events.join('').includes('SECRET'));
  } finally { console.log = old; }
});
test('sampler deadline closes timers and client without changing an in-flight delete', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let ends = 0;let release;
  const events = [];const old = console.log;console.log = (...args) => events.push(JSON.parse(args[1]));
  try {
    const observer = observeCleanup(() => ({ reserve: async () => ({ unsafe: async (sql) => sql === 'show server_version' ? [{ server_version: '18.1' }] : [] }), end: async () => { ends++; } }));
    const operation = observer.run('heartbeatRuns', () => new Promise((resolve) => { release = resolve; }));
    t.mock.timers.tick(29000);
    await observer.close();
    assert.equal(ends, 1);
    assert.ok(events.some((event) => event.event === 'sampler-deadline'));
    assert.ok(!events.some((event) => event.event === 'delete-end'));
    release(123);assert.equal(await operation, 123);
    t.mock.timers.tick(30000);assert.equal(ends, 1);
  } finally { console.log = old; }
});
test('query failure remains a safe observation error and the connection closes', async () => {
  let ends = 0;const events = [];const old = console.log;console.log = (...args) => events.push(JSON.parse(args[1]));
  try {
    const observer = observeCleanup(() => ({ reserve: async () => ({ unsafe: async () => { throw Error('SECRET database connection'); } }), end: async () => { ends++; } }));
    await observer.run('heartbeatRuns', async () => 5);
    await new Promise((resolve) => setImmediate(resolve));await observer.close();
    assert.equal(ends, 1);
    assert.ok(events.some((event) => event.event === 'observation-error'));
    assert.ok(!JSON.stringify(events).includes('SECRET'));
  } finally { console.log = old; }
});
test('coverage refuses invisible blockers, excessive PIDs and unknown fields', () => {
  assert.equal(validateSnapshot({ total: 1, records: [row(101, [0])] }).complete, false);
  assert.equal(validateSnapshot({ total: 129, records: [row(101)] }).complete, false);
  assert.throws(() => validateSnapshot({ total: 1, records: [{ ...row(101), state: null }] }));
  assert.throws(() => validateSnapshot({ total: 1, records: [{ ...row(101), lockGroups: [{ ...row(101).lockGroups[0], query: 'SECRET' }] }] }));
});
test('ingestion rejects unrecognized or inconsistent typed reports', () => fixture((path) => {
  writeFileSync(path, JSON.stringify({ code: 'complete', moduleCount: 1, report: { schema: 1, reason: 'passed', unhandledErrors: 0, modules: [], unexpected: 'SECRET' } }));
  assert.equal(readReport(path, [file]).code, 'invalid-structure');
  writeFileSync(path, JSON.stringify({ code: 'unexpected SECRET', moduleCount: 0 }));
  assert.equal(readReport(path, [file]).code, 'invalid-structure');
}));

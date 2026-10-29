import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { snapshotSql, validateSnapshot } from './snapshot.mjs';
import { readReport } from './reporter.mjs';
const require = createRequire(join(process.env.ATTENTION_FIXTURE_DEPENDENCIES ?? process.cwd(), 'package.json'));
const control = dirname(fileURLToPath(import.meta.url));
test('actual Vitest 5.0.3 reporter callback persists only safe metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'typed-reporter-'));
  try {
    const manifest = join(root, 'manifest.json');const output = join(root, 'typed-report.json');
    writeFileSync(manifest, JSON.stringify({ files: ['sample.test.js'] }));
    writeFileSync(join(root, 'sample.test.js'), "test('SECRET assertion title', () => { console.log('SECRET console'); expect(1).toBe(2); });\n");
    writeFileSync(join(root, 'config.mjs'), 'export default { test: { globals: true, include: ["sample.test.js"], maxWorkers: 1 } };');
    const entry = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
    assert.equal(JSON.parse(readFileSync(join(dirname(entry), 'package.json'))).version, '5.0.3');
    const result = spawnSync(process.execPath, [entry, 'run', '--config', join(root, 'config.mjs'), '--reporter=default', `--reporter=${join(control, 'reporter.mjs')}`], { cwd: root, env: { ...process.env, ATTENTION_MANIFEST_PATH: manifest, ATTENTION_REPORT_PATH: output }, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 1);
    const collected = readReport(output, ['sample.test.js']);
    assert.equal(collected.code, 'complete');
    assert.equal(collected.report.reason, 'failed');
    assert.equal(collected.report.modules[0].tests[0].status, 'failed');
    assert.ok(!readFileSync(output, 'utf8').includes('SECRET'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('real PostgreSQL retains blocker coverage with over 200 locks on a PID', async () => {
  const EmbeddedPostgres = require('embedded-postgres').default;
  const root = mkdtempSync(join(tmpdir(), 'snapshot-pg-'));
  const server = createServer();await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;await new Promise((resolve) => server.close(resolve));
  const pg = new EmbeddedPostgres({ databaseDir: join(root, 'db'), port, user: 'postgres', password: 'fixture', persistent: true, postgresFlags: ['-c', 'shared_buffers=16MB', '-c', 'max_connections=10'], onLog: () => {}, onError: () => {} });
  const clients = [];
  try {
    await pg.initialise();await pg.start();
    for (let i = 0; i < 3; i++) { const client = pg.getPgClient();await client.connect();clients.push(client); }
    const [holder, waiter, observer] = clients;
    await holder.query('begin');await holder.query('select pg_advisory_xact_lock(i) from generate_series(1,251) i');
    const waiting = waiter.query('select pg_advisory_lock(1)');
    let snapshot;
    for (let i = 0; i < 30; i++) {
      snapshot = validateSnapshot((await observer.query(snapshotSql)).rows[0]);
      if (snapshot.records.some((row) => row.blockers.length)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.records.length, 2);
    assert.ok(snapshot.records.some((row) => row.lockGroups.some((group) => group.locktype === 'advisory' && group.count >= 251)));
    assert.ok(snapshot.records.some((row) => row.blockers.length > 0));
    const old = await observer.query('select a.pid from pg_stat_activity a left join pg_locks l on l.pid=a.pid where a.datname=current_database() and a.pid<>pg_backend_pid() order by a.pid,l.locktype,l.mode limit 200');
    assert.equal(old.rows.length, 200);
    assert.equal(new Set(old.rows.map((row) => row.pid)).size, 1);
    await holder.query('rollback');await waiting;
  } finally {
    for (const client of clients) await client.end();
    await pg.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

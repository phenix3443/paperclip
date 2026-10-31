import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wrapPostgres } from './observer.mjs';

test('captures a sanitized fixture before destructive cleanup and preserves failure and close behavior', async () => {
  const events = [];
  const driver = () => {
    const sql = () => {};
    sql.unsafe = query => ({ then: (resolve, reject) => {
      events.push(query === 'delete from "companies"' ? 'cleanup' : 'query');
      return (query === 'broken' ? Promise.reject(new Error('original failure')) : Promise.resolve([])).then(resolve, reject);
    } });
    sql.end = async () => { events.push('close'); };
    return sql;
  };
  const wrapped = wrapPostgres(driver, async (_sql, phase) => events.push(`capture:${phase}`));
  const sql = wrapped('postgres://fixture:fixture@127.0.0.1:1234/fixture');
  await assert.rejects(Promise.resolve(sql.unsafe('broken')), /original failure/);
  await sql.unsafe('delete from "companies"');
  await sql.end();
  assert.deepEqual(events, ['query', 'capture:before_cleanup', 'cleanup', 'capture:before_close', 'close']);
});

test('capture failure cannot replace the original database failure or suppress cleanup', async () => {
  let closed = false;
  const original = () => Object.assign(() => {}, {
    unsafe: () => ({ then: (resolve, reject) => Promise.reject(new Error('database failure')).then(resolve, reject) }),
    end: async () => { closed = true; },
  });
  const sql = wrapPostgres(original, async () => { throw new Error('capture failure'); })('fixture');
  await assert.rejects(Promise.resolve(sql.unsafe('delete from "companies"')), /database failure/);
  await sql.end();
  assert.equal(closed, true);
});

test('transaction cleanup is observed and retains its original result', async () => {
  const events = [];
  const inner = Object.assign(() => {}, { unsafe: () => ({ then: (resolve, reject) => {
    events.push('delete'); return Promise.resolve('deleted').then(resolve, reject);
  } }) });
  const root = Object.assign(() => {}, { begin: callback => callback(inner) });
  const sql = wrapPostgres(() => root, async () => events.push('capture'))('fixture');
  assert.equal(await sql.begin(async tx => await tx.unsafe('delete from "companies"')), 'deleted');
  assert.deepEqual(events, ['capture', 'delete']);
});

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { wrapPostgres } from './observer.mjs';

const root = process.env.PAPERCLIP_DIAGNOSTIC_POSTGRES_ROOT
  ?? path.resolve(import.meta.dirname, '../../packages/db/node_modules/postgres');
const queryPath = path.join(root, 'src/query.js');
test('real postgres Query captures before catch, finally, execute and forEach dispatch', { skip: !existsSync(queryPath) }, async () => {
  const { Query } = await import(pathToFileURL(queryPath));
  for (const entry of ['then', 'catch', 'finally', 'execute', 'forEach']) {
    const events = [];
    const driver = () => Object.assign(() => {}, { unsafe: () => new Query(['delete from "companies"'], [], query => {
      events.push('cleanup'); query.resolve('original result');
    }) });
    const sql = wrapPostgres(driver, async () => { events.push('capture'); })('fixture');
    const query = sql.unsafe('delete from "companies"');
    const result = entry === 'then' ? await query
      : entry === 'forEach' ? await query.forEach(() => {})
      : entry === 'execute' ? await query.execute()
      : await query[entry](() => {});
    assert.equal(result, 'original result');
    assert.deepEqual(events, ['capture', 'cleanup'], entry);
  }
});

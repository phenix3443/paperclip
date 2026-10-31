import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

test('external preload captures fixture rows before deletion without editing the source module', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merge-tree-preload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const moduleRoot = path.join(root, 'postgres', 'src');
  const privateRoot = path.join(root, 'private');
  mkdirSync(moduleRoot, { recursive: true }); mkdirSync(privateRoot);
  const context = path.join(root, 'context.json'); writeFileSync(context, '{"case":7}');
  writeFileSync(path.join(root, 'postgres', 'package.json'), '{"type":"module"}');
  const source = `let deleted = false;
    export default function postgres() {
      const sql = () => {};
      sql.unsafe = query => ({ then(resolve, reject) {
        if (query.startsWith('delete')) deleted = true;
        const rows = query.includes('information_schema')
          ? [{table_name:'issues',column_name:'id'}, {table_name:'issues',column_name:'status'}]
          : deleted ? [] : [{id:'private-id',status:'in_progress',body:'SECRET'}];
        return Promise.resolve(rows).then(resolve, reject);
      } });
      sql.end = async () => {};
      return sql;
    }`;
  const target = path.join(moduleRoot, 'index.js'); writeFileSync(target, source);
  execFileSync(process.execPath, ['--import', new URL('./preload.mjs', import.meta.url).pathname,
    '--input-type=module', '-e', `import postgres from ${JSON.stringify(pathToFileURL(target).href)};
      const sql = postgres('postgres://fixture:fixture@127.0.0.1:1234/fixture');
      await sql.unsafe('delete from "companies"'); await sql.end();`], {
    env: { PATH: process.env.PATH, PAPERCLIP_FIXED_CI_PRIVATE: privateRoot, PAPERCLIP_FIXED_CI_CONTEXT: context }, stdio: 'pipe', timeout: 10000,
  });
  const rows = readFileSync(path.join(privateRoot, 'projection.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].phase, 'before_cleanup');
  assert.equal(rows[0].context.case, 7);
  assert.equal(rows[0].tables.issues[0].status, 'in_progress');
  assert.equal(rows[1].phase, 'before_close');
  assert.deepEqual(rows[1].tables.issues, []);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|private-id|postgres:\/\//);
  assert.equal(readFileSync(target, 'utf8'), source);
});

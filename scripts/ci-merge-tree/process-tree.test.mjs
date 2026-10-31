import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { boundedProcess } from './process-tree.mjs';

test('packaging deadline stops a writing grandchild as well as its direct parent', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merge-tree-process-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'heartbeat'); const parent = path.join(root, 'parent.mjs');
  const writer = `const fs=require('node:fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(output)},String(Date.now())),10)`;
  writeFileSync(parent, `import {spawn} from 'node:child_process';spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'ignore'});setInterval(()=>{},1000);`);
  await assert.rejects(boundedProcess(process.execPath, [parent], { env: { PATH: process.env.PATH }, deadline: Date.now() + 400 }), /process_deadline/);
  const last = readFileSync(output, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(readFileSync(output, 'utf8'), last);
});

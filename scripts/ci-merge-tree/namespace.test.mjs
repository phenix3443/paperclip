import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runPhase } from './phase.mjs';
import { isolatedCommand } from './namespace.mjs';

test('hosted synthetic namespace contains egress and reaps a writing descendant at its deadline', {
  skip: process.env.PAPERCLIP_DIAGNOSTIC_NAMESPACE_SMOKE !== 'true',
}, async t => {
  const root = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'merge-tree-namespace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temp = path.join(root, 'private-tmp'); mkdirSync(temp);
  const fixture = path.join(root, 'fixture.mjs');
  writeFileSync(fixture, `import {writeFileSync} from 'node:fs';import {spawn,execFileSync} from 'node:child_process';
    writeFileSync(${JSON.stringify(path.join(root, 'proof.json'))},JSON.stringify({pid:process.pid,
      route:execFileSync('ip',['route','show'],{encoding:'utf8'}),tmp:process.env.TMPDIR}));
    spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(path.join(root, 'heartbeat'))},String(Date.now())),10)`)}],{stdio:'ignore',detached:true});
    setInterval(()=>{},1000);`);
  const user = os.userInfo();
  const args = isolatedCommand({ env: { PATH: process.env.PATH, TMPDIR: temp }, command: process.execPath,
    args: [fixture], uid: user.uid, gid: user.gid, seconds: 2 });
  const result = await runPhase({ name: 'namespace_smoke', command: 'sudo', args, env: { PATH: process.env.PATH },
    cwd: root, privateRoot: root, stage: root, deadline: Date.now() + 10000 });
  assert.equal(result.status, 'timed_out');
  const proof = JSON.parse(readFileSync(path.join(root, 'proof.json')));
  assert.equal(proof.pid, 1); assert.equal(proof.route.trim(), '');
  const last = readFileSync(path.join(root, 'heartbeat'), 'utf8');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(readFileSync(path.join(root, 'heartbeat'), 'utf8'), last);
});

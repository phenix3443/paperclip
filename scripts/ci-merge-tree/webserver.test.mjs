import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { observeWebServer } from './webserver.mjs';

test('a synthetic build failure preserves exit and prevents server startup', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merge-tree-server-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const code = await observeWebServer({ source: root, privateRoot: root,
    env: { PATH: process.env.PATH, PAPERCLIP_FIXED_CI_DEADLINE: String(Date.now() + 10000) },
    build: { command: process.execPath, args: ['-e', 'process.exit(17)'] },
    server: { command: '/must/not/start', args: [] } });
  assert.equal(code, 17);
  const stages = JSON.parse(readFileSync(path.join(root, 'webserver-status.json')));
  assert.equal(stages.length, 1); assert.equal(stages[0].name, 'ui_build');
});

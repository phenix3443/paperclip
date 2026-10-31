import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('trace packaging drops secret-bearing attachments and nested archives, and rejects symlinks', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merge-tree-archive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'input'); mkdirSync(input);
  execFileSync('python3', ['-c', `import zipfile,json,sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 z.writestr('0-trace.trace', json.dumps({'type':'before','apiName':'page.goto','params':{'url':'https://secret.invalid/?token=SECRET'}}))
 z.writestr('resources/attachment.zip', 'SECRET')
 z.writestr('0-trace.network', 'Cookie: SECRET')
`, path.join(input, 'trace.zip')]);
  const output = path.join(root, 'sanitized.zip'); const gaps = path.join(root, 'gaps.json');
  const script = new URL('./sanitize-traces.py', import.meta.url).pathname;
  execFileSync('python3', [script, input, output, gaps]);
  const content = execFileSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print([z.read(n).decode() for n in z.namelist()])', output], { encoding: 'utf8' });
  assert.match(content, /page.goto/);
  assert.doesNotMatch(content, /SECRET|secret.invalid|Cookie/);
  assert.equal(JSON.parse(readFileSync(gaps))[0].omittedEntries, 2);
  execFileSync('python3', ['-c', `import zipfile,sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 e=zipfile.ZipInfo('resources/link');e.external_attr=(0o120777 << 16);z.writestr(e,'secret')`, path.join(input, 'trace.zip')]);
  assert.throws(() => execFileSync('python3', [script, input, output, gaps], { stdio: 'pipe' }), error => error.status === 1);
});

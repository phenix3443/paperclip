import path from 'node:path';
import { writeFileSync, realpathSync } from 'node:fs';
import { BASE, HEAD, fixedRow, validateDispatch, verifySource } from './identity.mjs';

const [arm, lane, source, output] = process.argv.slice(2);
const row = fixedRow(arm, lane);
const sourceRoot = realpathSync(source);
const outputParent = realpathSync(path.dirname(output ?? '.'));
if (!path.isAbsolute(output ?? '') || outputParent === sourceRoot || outputParent.startsWith(`${sourceRoot}${path.sep}`)) {
  throw new Error('evidence_root_must_be_external');
}
validateDispatch({ repository: process.env.GITHUB_REPOSITORY, attempt: process.env.GITHUB_RUN_ATTEMPT,
  ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA,
  expectedSha: process.env.EXPECTED_CONTROL_SHA, executionKey: process.env.EXECUTION_KEY });
const identity = verifySource(source, { sha: row.sha, ...(arm === 'merge' ? { parents: [BASE, HEAD] } : {}) });
writeFileSync(output, JSON.stringify({ ...row, ...identity }, null, 2), { flag: 'wx' });

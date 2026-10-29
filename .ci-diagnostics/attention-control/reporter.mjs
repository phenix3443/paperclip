import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';

const states = new Set(['passed', 'failed', 'skipped']);
const reasons = new Set(['passed', 'failed', 'interrupted']);
const failureClass = (errors) => errors?.length ? (errors.some((error) => typeof error.message === 'string' && error.message.includes('Hook timed out in 30000ms')) ? 'hook-timeout-30000ms' : 'redacted-test-failure') : null;
const hasKeys = (value, keys) => value && typeof value === 'object' && Object.keys(value).every((key) => keys.includes(key));

export default class SafeReporter {
  constructor(options = {}) {
    this.options = options;
  }
  onTestRunEnd(modules, errors, reason) {
    const output = this.options.output ?? process.env.ATTENTION_REPORT_PATH;
    let code = 'projection-failed';
    let moduleCount = 0;
    try {
      const root = this.options.root ?? process.cwd();
      const files = this.options.files ?? JSON.parse(readFileSync(process.env.ATTENTION_MANIFEST_PATH, 'utf8')).files;
      moduleCount = modules.length;
      const projected = modules.map((module) => ({ file: relative(root, module.moduleId).replaceAll('\\', '/'), status: module.state(), failure: failureClass(module.errors()),
        tests: Array.from(module.children.allTests(), (test, index) => ({ index, status: test.result().state, duration: test.diagnostic()?.duration ?? null, failure: failureClass(test.result().errors) })) }));
      const report = { schema: 1, reason, unhandledErrors: errors.length, modules: projected };
      const verdict = validateReport(report, files);
      code = verdict.code;
      writeFileSync(output, JSON.stringify(verdict.code === 'complete' ? { code, moduleCount, report } : { code, moduleCount }));
    } catch {
      try { writeFileSync(output, JSON.stringify({ code, moduleCount })); } catch { /* The runner classifies missing output. */ }
    }
  }
}

export function validateReport(report, files) {
  try {
    assert.ok(hasKeys(report, ['schema', 'reason', 'unhandledErrors', 'modules']));
    assert.equal(report.schema, 1);
    assert.ok(reasons.has(report.reason));
    assert.ok(Number.isSafeInteger(report.unhandledErrors) && report.unhandledErrors >= 0);
    assert.ok(Array.isArray(report.modules) && report.modules.length <= 103);
    for (const module of report.modules) {
      assert.ok(hasKeys(module, ['file', 'status', 'failure', 'tests']));
      assert.equal(typeof module.file, 'string');
      assert.ok(states.has(module.status));
      assert.ok([null, 'hook-timeout-30000ms', 'redacted-test-failure'].includes(module.failure));
      assert.ok(Array.isArray(module.tests) && module.tests.length <= 100000);
      for (const [index, test] of module.tests.entries()) {
        assert.ok(hasKeys(test, ['index', 'status', 'duration', 'failure']));
        assert.equal(test.index, index);
        assert.ok(states.has(test.status));
        assert.ok(test.duration === null || (Number.isFinite(test.duration) && test.duration >= 0));
        assert.ok([null, 'hook-timeout-30000ms', 'redacted-test-failure'].includes(test.failure));
      }
    }
  } catch { return { code: 'invalid-structure' }; }
  const actual = report.modules.map((module) => module.file);
  if (new Set(actual).size !== actual.length || JSON.stringify([...actual].sort()) !== JSON.stringify([...files].sort())) return { code: 'inventory-mismatch', moduleCount: actual.length };
  return { code: 'complete', report };
}

export function readReport(path, files) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return { code: 'report-missing' }; }
  let payload;
  try { payload = JSON.parse(raw); } catch { return { code: 'report-parse-failed' }; }
  if (!hasKeys(payload, ['code', 'moduleCount', 'report'])) return { code: 'invalid-structure' };
  if (['projection-failed', 'inventory-mismatch', 'invalid-structure'].includes(payload.code)) return { code: payload.code, moduleCount: Number.isSafeInteger(payload.moduleCount) ? payload.moduleCount : null };
  if (payload.code === 'complete' && payload.moduleCount !== payload.report?.modules?.length) return { code: 'invalid-structure' };
  if (payload.code !== 'complete') return { code: 'invalid-structure' };
  return validateReport(payload.report, files);
}

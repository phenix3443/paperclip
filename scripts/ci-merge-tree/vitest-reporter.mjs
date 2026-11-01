import { record, location, setContext, errorProjection } from './reporter-common.mjs';

export default class {
  index = 0;
  cases = new Map();
  onTestModuleCollected(module) {
    for (const test of module.children.allTests()) {
      record('cases.jsonl', { kind: 'selected', worker: process.pid, testId: test.id,
        ...location(module.moduleId, test.location?.line, test.location?.column) });
    }
  }
  onTestCaseReady(test) {
    const id = ++this.index;
    this.cases.set(test.id, id);
    setContext(id);
    record('cases.jsonl', { kind: 'start', worker: process.pid, case: id, testId: test.id,
      ...location(test.module?.moduleId, test.location?.line, test.location?.column) });
  }
  onTestCaseResult(test) {
    const result = test.result();
    record('cases.jsonl', { kind: 'end', worker: process.pid, case: this.cases.get(test.id),
      state: ['passed', 'failed', 'skipped', 'pending'].includes(result.state) ? result.state : 'unknown',
      errors: (result.errors ?? []).map(errorProjection) });
  }
}

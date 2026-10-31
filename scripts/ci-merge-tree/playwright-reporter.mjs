import { record, location, setContext, errorProjection } from './reporter-common.mjs';

export default class {
  index = 0;
  cases = new Map();
  onBegin(_config, suite) {
    for (const test of suite.allTests()) {
      const id = ++this.index;
      this.cases.set(test.id, id);
      record('cases.jsonl', { kind: 'selected', case: id, ...location(test.location.file, test.location.line, test.location.column) });
    }
  }
  onTestBegin(test) {
    const id = this.cases.get(test.id);
    setContext(id);
    record('cases.jsonl', { kind: 'start', case: id });
  }
  onTestEnd(test, result) {
    record('cases.jsonl', { kind: 'end', case: this.cases.get(test.id),
      status: result.status, retry: result.retry, duration: result.duration,
      errors: result.errors.map(errorProjection) });
  }
  onStdOut() {}
  onStdErr() {}
}

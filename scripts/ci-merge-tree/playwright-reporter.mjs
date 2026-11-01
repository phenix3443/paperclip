import { record, location, setContext, errorProjection } from './reporter-common.mjs';

export default class {
  index = 0;
  cases = new Map();
  onBegin(_config, suite) {
    for (const test of suite.allTests()) {
      const id = ++this.index;
      this.cases.set(test.id, id);
      record('cases.jsonl', { kind: 'selected', case: id, testId: test.id, ...location(test.location.file, test.location.line, test.location.column) });
    }
  }
  onTestBegin(test) {
    const id = this.cases.get(test.id);
    setContext(id);
    record('cases.jsonl', { kind: 'start', case: id });
  }
  onTestEnd(test, result) {
    for (const attachment of result.attachments ?? []) {
      if (attachment.name === 'trace' && attachment.path) record('trace-index.jsonl', { testId: test.id, path: attachment.path });
    }
    record('cases.jsonl', { kind: 'end', testId: test.id, case: this.cases.get(test.id),
      status: result.status, retry: result.retry, duration: result.duration,
      errors: result.errors.map(errorProjection) });
  }
  onError(error) {
    record('cases.jsonl', { kind: 'global_error', phase: /webServer/.test(error.message ?? '') ? 'setup_webserver' : 'infrastructure', error: errorProjection(error) });
  }
  onStdOut() {}
  onStdErr() {}
}

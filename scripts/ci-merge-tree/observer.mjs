import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FIELDS, projectFixture } from './evidence.mjs';

function cleanupQuery(query, values = []) {
  return /\b(?:delete\s+from\s+"?companies"?|drop\s+database|truncate\b)/i.test(query)
    || (/^update\s+"?(?:chat_endpoints|chat_conversations)"?/i.test(query)
      && values.some(value => value === 'paused' || value === 'completed'));
}

export function wrapPostgres(original, capture) {
  const factory = (...args) => {
    const raw = original(...args);
    let queue = Promise.resolve();
    const snapshot = phase => {
      queue = queue.then(() => capture(raw, phase, args)).catch(() => {});
      return queue;
    };
    const wrap = raw => new Proxy(raw, {
      get(target, key) {
        if (key === 'end') return async (...endArgs) => {
          await snapshot('before_close');
          return target.end(...endArgs);
        };
        if (key === 'begin' || key === 'savepoint') return (...callArgs) => target[key](...callArgs.map(arg =>
          typeof arg === 'function' ? inner => arg(wrap(inner)) : arg));
        if (key === 'unsafe') return (query, values, ...rest) => {
          const result = target.unsafe(query, values, ...rest);
          if (!cleanupQuery(query, values)) return result;
          if (typeof result.handler === 'function') {
            const originalHandler = result.handler;
            result.handler = Object.assign(query => {
              snapshot('before_cleanup').then(() => originalHandler(query)).catch(error => query.reject(error));
            }, originalHandler);
          } else {
            const then = result.then.bind(result);
            result.then = (resolve, reject) => snapshot('before_cleanup').then(() => then(resolve, reject));
          }
          return result;
        };
        return Reflect.get(target, key);
      },
    });
    return wrap(raw);
  };
  return Object.assign(factory, original);
}

export function fixtureCapture(original, root, contextFile) {
  const project = projectFixture();
  const append = (name, value) => appendFileSync(path.join(root, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  let sequence = 0;
  return async (_raw, phase, args) => {
    let sql;
    try {
      const url = new URL(args[0]);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('nonfixture_database');
      let context = null;
      const currentTask = globalThis.__vitest_worker__?.current;
      if (currentTask && /^[A-Za-z0-9_:-]+$/.test(currentTask.id ?? '')) {
        context = { testId: currentTask.id, scope: currentTask.type === 'test' ? 'test' : 'suite' };
      }
      try {
        const current = !context && JSON.parse(readFileSync(contextFile, 'utf8'));
        if (current && Number.isInteger(current.case) && current.case >= 0) context = { case: current.case };
      } catch {}
      if (!context) append('capture-gaps.jsonl', { kind: 'missing_test_context', phase, worker: process.pid });
      sql = original(url.toString(), { max: 1, connect_timeout: 1, idle_timeout: 1,
        connection: { statement_timeout: 1000, application_name: 'fixed-ci-observer' }, onnotice: () => {} });
      const columns = await sql.unsafe("select table_name,column_name from information_schema.columns where table_schema='public'");
      const schema = Object.entries(FIELDS).flatMap(([table, fields]) => {
        const available = fields.filter(field => columns.some(row => row.table_name === table && row.column_name === field));
        return available.length ? [[table, available]] : [];
      });
      const snapshot = { schema: 1, worker: process.pid, sequence: ++sequence, phase,
        at: new Date().toISOString(), context, fieldAllowlist: FIELDS, tables: {} };
      for (const [table, fields] of schema) {
        const rows = await sql.unsafe(`select ${fields.map(field => `"${field}"`).join(',')} from "${table}" limit 2001`);
        if (rows.length > 2000) append('capture-gaps.jsonl', { kind: 'projection_row_cap', table, worker: process.pid });
        snapshot.tables[table] = project(table, rows.slice(0, 2000));
      }
      append('projection.jsonl', snapshot);
    } catch {
      append('capture-gaps.jsonl', { kind: 'observer_failure', phase, worker: process.pid });
    } finally { await sql?.end({ timeout: 1 }).catch(() => {}); }
  };
}

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { safeLog, FIELDS, projectFixture } from './evidence.mjs';

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
          if (typeof result.reject === 'function' && typeof capture.onError === 'function') {
            const reject = result.reject;
            result.reject = error => {
              try { capture.onError(error); } catch {}
              return reject(error);
            };
          }
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
  const capture = async (_raw, phase, args) => {
    let sql;
    try {
      const url = new URL(args[0]);
      if (url.pathname === '/postgres' || /paperclip_test_template_/.test(url.pathname)) return;
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
      if (!context) context = { scope: 'setup' };
      sql = original(url.toString(), { max: 1, connect_timeout: 1, idle_timeout: 1,
        connection: { statement_timeout: 1000, application_name: 'fixed-ci-observer' }, onnotice: () => {} });
      const versionRows = await sql.unsafe("select current_setting('server_version') as version");
      const version = versionRows[0]?.version;
      const databaseVersion = /^\d+(?:\.\d+){0,2}(?:(?:beta|rc)\d+)?$/.test(version ?? '') ? version : 'unknown';
      const columns = await sql.unsafe("select table_name,column_name from information_schema.columns where table_schema='public'");
      const missingSchema = [];
      const schema = Object.entries(FIELDS).flatMap(([table, fields]) => {
        const available = fields.filter(field => columns.some(row => row.table_name === table && row.column_name === field));
        const missing = fields.filter(field => !available.includes(field));
        if (missing.length) missingSchema.push({ table, columns: missing });
        return available.length ? [[table, available]] : [];
      });
      const snapshot = { schema: 1, worker: process.pid, sequence: ++sequence, phase,
        at: new Date().toISOString(), context, databaseVersion, fieldAllowlist: FIELDS, missingSchema, tables: {} };
      if (missingSchema.length && (phase === 'before_cleanup' || context.scope === 'test')) {
        append('capture-gaps.jsonl', { kind: 'fixture_schema_gap', phase, missingSchema });
      }
      for (const [table, fields] of schema) {
        const rows = await sql.unsafe(`select ${fields.map(field => `"${field}"`).join(',')} from "${table}" ${fields.includes('created_at') ? 'order by "created_at", "id"' : fields.includes('id') ? 'order by "id"' : ''} limit 2001`);
        if (rows.length > 2000) append('capture-gaps.jsonl', { kind: 'projection_row_cap', table, worker: process.pid });
        snapshot.tables[table] = project(table, rows.slice(0, 2000));
      }
      append('projection.jsonl', snapshot);
    } catch {
      append('capture-gaps.jsonl', { kind: 'observer_failure', phase, worker: process.pid });
    } finally { await sql?.end({ timeout: 1 }).catch(() => {}); }
  };
  appendFileSync(path.join(root, 'database-errors.jsonl'), '', { mode: 0o600 });
  capture.onError = error => append('database-errors.jsonl', { at: new Date().toISOString(), worker: process.pid,
    context: /^[A-Za-z0-9_:-]+$/.test(globalThis.__vitest_worker__?.current?.id ?? '')
      ? { testId: globalThis.__vitest_worker__.current.id } : { scope: 'service' },
    code: ['55P03', '40P01', '57014', '23505', '23503', '42P01'].includes(error?.code) ? error.code : '[redacted]',
    signature: safeLog(error?.message ?? '') });
  return capture;
}

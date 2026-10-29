import { performance } from "node:perf_hooks";

import { snapshotSql, validateSnapshot } from "./snapshot.mjs";

let sequence = 0;

export function observeCleanup(openClient) {
  const hook = ++sequence;
  const start = performance.now();
  let client;
  let current = null;
  let connection;
  let closed = false;
  let busy = false;
  let closing;
  const emit = (event, data = {}) => console.log("[attention-control]", JSON.stringify({ event, hook, elapsedMs: performance.now() - start, ...data }));
  const failure = () => emit("observation-error");
  try { client = openClient(); } catch {
    failure();
    return { run: async (_name, operation) => operation(), close: async () => {} };
  }
  const ready = (async () => {
    connection = await client.reserve();
    if (closed) return;
    await connection.unsafe("set default_transaction_read_only = on");
    await connection.unsafe("set statement_timeout = '1000ms'");
    const [version] = await connection.unsafe("show server_version");
    emit("postgres-version", { version: version.server_version });
  })().catch(failure);
  const sample = async () => {
    if (closed || busy || !current || performance.now() - current.started < 5000) return;
    busy = true;
    const operation = current;
    try {
      await ready;
      if (closed || !connection || current !== operation) return;
      const [raw] = await connection.unsafe(snapshotSql);
      const snapshot = validateSnapshot(raw);
      emit("wait-sample", { operation: operation.name, snapshot });
    } catch { failure(); }
    finally { busy = false; }
  };
  const interval = setInterval(() => { void sample(); }, 1000);
  interval.unref();
  const close = () => {
    if (closing) return closing;
    closed = true;
    clearInterval(interval);
    clearTimeout(deadline);
    closing = Promise.resolve().then(() => client.end({ timeout: 1 })).catch(failure);
    return closing;
  };
  const deadline = setTimeout(() => { emit("sampler-deadline"); void close(); }, 29000);
  deadline.unref();
  return {
    async run(name, operation) {
      current = { name, started: performance.now() };
      emit("delete-start", { operation: name });
      try { return await operation(); }
      finally {
        emit("delete-end", { operation: name, durationMs: performance.now() - current.started });
        current = null;
      }
    },
    close,
  };
}

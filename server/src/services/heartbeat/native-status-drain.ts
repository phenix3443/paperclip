import { databaseWorkScopeKey, type Db } from "@paperclipai/db";

export type NativeWakeScope = { companyId?: string; agentId?: string; projectId?: string };
export type NativeWakeDispatchInput = NativeWakeScope & { limit?: number; staleClaimMs?: number };
type Result = { scanned: number; dispatched: number; recovered: number; deferred: number; promoted: number };
type Input = { id: string; companyId: string; agentId: string };
type Pending = { input: NativeWakeDispatchInput; generation: number; consumed: number; ids: Set<string>; running?: Promise<Result> };
type State = { tail: Promise<unknown>; pending: Map<string, Pending>; active: Map<string, Input>; stopped: boolean };
const states = new WeakMap<object, State>();
export const nativeWakeScopeKey = (scope: NativeWakeScope) => JSON.stringify([scope.companyId, scope.agentId, scope.projectId]);

export function createNativeStatusDrain(db: Db,
  scan: (input: NativeWakeDispatchInput, ids?: string[]) => Promise<Result>,
  canRun: () => Promise<boolean>,
) {
  const key = databaseWorkScopeKey(db);
  let state = states.get(key);
  if (!state) states.set(key, state = { tail: Promise.resolve(), pending: new Map(), active: new Map(), stopped: false });
  const owned = state;
  function dispatch(input: NativeWakeDispatchInput = {}) {
    const scope = nativeWakeScopeKey(input);
    let pending = owned.pending.get(scope);
    if (!pending) owned.pending.set(scope, pending = { input, generation: 0, consumed: 0, ids: new Set() });
    pending.generation++;
    for (const row of owned.active.values()) {
      if ((!input.companyId || input.companyId === row.companyId) && (!input.agentId || input.agentId === row.agentId)) pending.ids.add(row.id);
    }
    if (pending.running) return pending.running;
    const work = pending;
    const promise = owned.tail.then(async () => {
      let result: Result = { scanned: 0, dispatched: 0, recovered: 0, deferred: 0, promoted: 0 };
      for (let pass = 0; pass < 2 && !owned.stopped && await canRun(); pass++) {
        const generation = work.generation;
        const ids = [...work.ids];
        work.ids.clear();
        try {
          const page = await scan(work.input, pass > 0 || ids.length ? ids : undefined);
          for (const key of ["scanned", "dispatched", "recovered", "deferred", "promoted"] as const) result[key] += page[key];
        }
        catch (error) { for (const id of ids) work.ids.add(id); throw error; }
        work.consumed = generation;
        if (work.generation === generation) break;
      }
      return result;
    });
    work.running = promise;
    owned.tail = promise.catch(() => undefined);
    void promise.finally(() => {
      work.running = undefined;
      if (work.consumed === work.generation) owned.pending.delete(scope);
    }).catch(() => undefined);
    return promise;
  }
  return {
    dispatch,
    observe(rows: Input[]) {
      for (const row of rows) owned.active.set(row.id, row);
      return () => { for (const row of rows) owned.active.delete(row.id); };
    },
    async resume() {
      owned.stopped = false;
      for (const pending of [...owned.pending.values()]) await dispatch(pending.input);
    },
    async stop() { owned.stopped = true; await owned.tail; },
  };
}

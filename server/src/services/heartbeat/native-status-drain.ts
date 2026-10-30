import { databaseWorkScopeKey, type Db } from "@paperclipai/db";

export type NativeWakeScope = { companyId?: string; agentId?: string; projectId?: string };
export type NativeWakeDispatchInput = NativeWakeScope & { limit?: number; staleClaimMs?: number; releaseThrough?: string };
export type NativeWakeCursor = { requestedAt: string; id: string };
type Result = { scanned: number; dispatched: number; recovered: number; deferred: number; promoted: number; next?: NativeWakeCursor | null };
type Input = { id: string; companyId: string; agentId: string };
type Pending = { input: NativeWakeDispatchInput; generation: number; consumed: number; ids: Set<string>; observed: Set<string>; running?: Promise<Result> };
type State = { running: Map<Promise<unknown>, NativeWakeDispatchInput>; pending: Map<string, Pending>; active: Map<string, Input>; stopped: boolean };
function overlaps(a: NativeWakeScope, b: NativeWakeScope) {
  if (a.companyId && b.companyId && a.companyId !== b.companyId) return false;
  if (a.agentId && b.agentId && a.agentId !== b.agentId) return false;
  if (a.projectId && b.projectId && a.projectId !== b.projectId) return false;
  return true;
}
const states = new WeakMap<object, State>();
export const nativeWakeScopeKey = (scope: NativeWakeScope) => JSON.stringify([scope.companyId, scope.agentId, scope.projectId]);

export function createNativeStatusDrain(db: Db,
  scan: (input: NativeWakeDispatchInput, ids?: string[], after?: NativeWakeCursor | null) => Promise<Result>,
  canRun: () => Promise<boolean>,
) {
  const key = databaseWorkScopeKey(db);
  let state = states.get(key);
  if (!state) states.set(key, state = { running: new Map(), pending: new Map(), active: new Map(), stopped: false });
  const owned = state;
  function dispatch(input: NativeWakeDispatchInput = {}) {
    const scope = `${nativeWakeScopeKey(input)}:${input.releaseThrough ? "release" : "recovery"}`;
    let pending = owned.pending.get(scope);
    if (!pending) owned.pending.set(scope, pending = { input, generation: 0, consumed: 0, ids: new Set(), observed: new Set() });
    pending.generation++;
    for (const id of pending.observed) pending.ids.add(id);
    for (const row of owned.active.values()) {
      if ((!input.companyId || input.companyId === row.companyId) && (!input.agentId || input.agentId === row.agentId)) pending.ids.add(row.id);
    }
    if (pending.running) return pending.running;
    const work = pending;
    const blockers = [...owned.running].filter(([, scope]) => overlaps(scope, input)).map(([promise]) => promise);
    const promise = Promise.allSettled(blockers).then(async () => {
      let result: Result = { scanned: 0, dispatched: 0, recovered: 0, deferred: 0, promoted: 0 };
      for (let pass = 0; pass < 2 && !owned.stopped && await canRun(); pass++) {
        const generation = work.generation;
        const ids = [...work.ids];
        work.ids.clear();
        let after: NativeWakeCursor | null = null;
        try {
          do {
            work.observed.clear();
            const page = await scan(work.input, !work.input.releaseThrough && ids.length ? ids : undefined, after);
            for (const key of ["scanned", "dispatched", "recovered", "deferred", "promoted"] as const) result[key] += page[key];
            after = work.input.releaseThrough ? page.next ?? null : null;
          } while (after && !owned.stopped && await canRun());
        }
        catch (error) { for (const id of ids) work.ids.add(id); throw error; }
        if (after) break;
        work.consumed = generation;
        if (work.generation === generation) break;
      }
      return result;
    });
    work.running = promise;
    owned.running.set(promise, input);
    void promise.finally(() => {
      owned.running.delete(promise);
      work.running = undefined;
      if (work.consumed === work.generation) owned.pending.delete(scope);
    }).catch(() => undefined);
    return promise;
  }
  return {
    dispatch,
    observe(rows: Input[]) {
      for (const row of rows) {
        owned.active.set(row.id, row);
        for (const work of owned.pending.values()) if (work.running && overlaps(work.input, row)) work.observed.add(row.id);
      }
      return () => { for (const row of rows) owned.active.delete(row.id); };
    },
    async resume() {
      owned.stopped = false;
      for (const pending of [...owned.pending.values()]) await dispatch(pending.input);
    },
    async stop() { owned.stopped = true; await Promise.allSettled([...owned.running.keys()]); },
  };
}

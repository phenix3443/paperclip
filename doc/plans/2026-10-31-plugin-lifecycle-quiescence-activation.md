# Plugin lifecycle quiescence and activation plan

Status: draft for independent review.

Source requirement: [fork issue #325](https://github.com/phenix3443/paperclip/issues/325). Implementation: [fork issue #326](https://github.com/phenix3443/paperclip/issues/326), blocked by approval and merge of this plan. Consumer requirement: [ai-team #879](https://github.com/phenix3443/ai-team/issues/879); approved consumer plan: [ai-team #892](https://github.com/phenix3443/ai-team/pull/892) (head `c7e650c6d0a87d28e13b20452e84b321173f3832`, merge `e47e92a9fe70760f4b5838c12a52e973b0f68a50`), `docs/paperclip/plugin-reinstall-race-plan.md`.

This document specifies the smallest native fix for the plugin watcher/reinstall race. It changes no runtime code. It adds no table, route, permission, scheduler, maintenance lease or hard-delete path, and it does not reproduce the race against a live instance.

## 1. Problem

A local-path plugin can be rebuilt while the dev watcher reloads it. A client that then disables, soft-deletes or reinstalls the plugin has no reliable completion boundary. The recorded incident (ai-team #879): the plugin row read `ready` five times, the watcher started a reload, the worker stayed `starting`, and the following DELETE/install failed with `Worker already registered (status: starting)`.

The cause is that lifecycle work on one plugin is not mutually exclusive, and "stopped" is not proven before a response says so. The row status is a database fact, not a worker fact.

## 2. Verified baseline

The deployed instance runs `5d427f93a43d796a77f635e010993436d4141390` (consumer plan, read-only `GET /api/health`). On the current `develop` base of this PR, `git diff 5d427f93a43d796a77f635e010993436d4141390 HEAD` is empty for every file cited below, so the citations hold for both.

| Defect | Source at `5d427f93` |
| --- | --- |
| D1. Two lifecycle instances with private emitters. The app instance (no loader) feeds the dev watcher; the route instance (with loader) serves HTTP. A route `disable`/`DELETE` emits on the route emitter only, so the watcher never unwatches. | [app.ts#L829](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/app.ts#L829), [app.ts#L1265](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/app.ts#L1265), [routes/plugins.ts#L544](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/routes/plugins.ts#L544) |
| D2. No per-plugin exclusion. `enable`, `disable`, `unload`, `load`, `restartWorker` read the row, then await teardown/activation with nothing preventing an interleaved operation. `restartWorker` reads `ready` before its awaits, so it can reactivate after an uninstall. | [plugin-lifecycle.ts#L466-L620](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-lifecycle.ts#L466), [restartWorker#L757](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-lifecycle.ts#L757) |
| D3. Watcher reload uses the bare `handle.restart()` branch (app lifecycle has no runtime loader). It runs `stopInternal` then `startInternal` on the same registered handle, outside `startupLocks`. | [plugin-lifecycle.ts#L812](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-lifecycle.ts#L812), [worker-manager restart#L3573](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-worker-manager.ts#L3573) |
| D4. Watcher fire-and-forget. The debounce callback starts `restartWorker` and only catches; `unwatch` closes the watcher and clears the timer but never joins an already-started reload. | [plugin-dev-watcher.ts#L234-L262](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-dev-watcher.ts#L234), [unwatch#L316](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-dev-watcher.ts#L316) |
| D5. Loader teardown stops the worker only if `isRunning` (status `running`). A `starting`, `backoff` or `crashed` handle stays registered. Stop failures are logged and swallowed. | [plugin-loader.ts#L2198](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-loader.ts#L2198), [lifecycle stopWorkerIfRunning#L398](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-lifecycle.ts#L398) |
| D6. Stale start continuation. `stopInternal` during `starting` does not join the pending `startInternal`. If initialize resolves first, `startInternal` sets `running` after the stop. If the stop wins, the rejected initialize sets `crashed` over `stopped`. | [startInternal#L3184](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-worker-manager.ts#L3184), [stopInternal#L3233](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-worker-manager.ts#L3233) |
| D7. Crash retry. `scheduleRestart` calls `startInternal` from a timer. `stopInternal` cancels a pending timer, but a timer that already fired is not joined, so a retry in flight can revive the worker after a stop. | [scheduleRestart#L3141](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-worker-manager.ts#L3141) |
| D8. Process exit not proven. `stopInternal` sets `stopped` even when the child is still alive after SIGKILL; `manager.stopWorker` then deletes the registration. | [stopInternal#L3233](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-worker-manager.ts#L3233), [stopWorker#L3880](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-worker-manager.ts#L3880) |
| D9. Install is unserialized. The route runs `loader.installPlugin` (row write) then `lifecycle.load` with no exclusion against the watcher or a concurrent DELETE. | [routes/plugins.ts#L1240-L1270](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/routes/plugins.ts#L1240) |
| D10. Not idempotent. `disable` on `disabled` and soft `DELETE` on `uninstalled` return 400 without checking for a surviving worker, so a client cannot re-establish quiescence after a lost response. | [disable#L512](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-lifecycle.ts#L512), [unload#L535](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-lifecycle.ts#L535) |
| D11. Reentrancy. Activation failure calls `runtimeServices.lifecycleManager.markError` (the app instance) from inside a route lifecycle operation; `loadSingle` on an `installed` row calls `lifecycleManager.load`. A naive per-plugin lock would deadlock here. | [plugin-loader.ts#L2517](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-loader.ts#L2517), [plugin-loader.ts#L2090](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-loader.ts#L2090) |

Registry soft reinstall already preserves the row, id, plugin data and company config ([plugin-registry.ts#L151](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-registry.ts#L151)); this plan keeps that unchanged.

## 3. Contracts

**Q (quiescence).** A successful `POST /api/plugins/:id/disable` or soft `DELETE /api/plugins/:id` responds only after all of the following hold for that plugin:

1. The row is `disabled` (or `uninstalled`, soft).
2. The current watcher registration is withdrawn: its debounce timer is cleared, its pending path lookup is invalidated, and it can no longer schedule a reload.
3. Every lifecycle operation accepted before this one has finished (drained), including watcher reloads, config restarts and starts.
4. No worker handle for the plugin is registered in the worker manager, the last child process has exited, and no start continuation or crash retry for it is pending.
5. Any operation accepted earlier but not yet run, and any continuation that read an older state, is invalid and cannot register a worker.

Q lasts until the next explicitly accepted `enable` or `install` for the same plugin key. Nothing else (watcher, config save, crash retry, startup retry of `error` rows, stale continuation) ends Q.

**A (activation).** A successful `POST /api/plugins/:id/enable` or `POST /api/plugins/install` responds only after the accepted target generation has finished initialize and runtime registration (worker `running`, jobs synced and registered, tools registered), with the row `ready` and its `version`/`packagePath` taken from the target package. A `ready` row alone does not satisfy A, and neither do stable samples. A is verified externally with existing endpoints only (section 8).

## 4. Design

### 4.1 Shared lifecycle context

Add one process-level `PluginLifecycleShared` object holding:

- `emitter`: the lifecycle `EventEmitter` (replaces the per-instance one);
- `serializer`: the per-plugin-key FIFO queue (4.2);
- `epochs`: `Map<pluginId, number>`, bumped by every accepted Q or A operation (4.4);
- `quiesced`: `Set<pluginId>`, set by Q and cleared only by an explicit A;
- `fenced`: `Map<pluginId, reason>`, set when a stop could not be proven (4.7);
- `watchWithdrawers`: synchronous callbacks registered by the dev watcher (4.5).

`pluginLifecycleManager(db, options)` obtains the context from a module-level `WeakMap<PluginWorkerManager, PluginLifecycleShared>` keyed by its `workerManager`. Production builds exactly one worker manager ([app.ts#L542](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/app.ts#L542)) and passes it to both the app and route lifecycle, so the two instances share emitter, queue and epochs with no new constructor parameter or wiring. An instance without a worker manager (state-only tests) gets a private context. A test asserts that the app and route instances built by the real wiring share the context (matrix N4).

Sharing the emitter fixes D1 and also delivers route events to the two other existing subscribers, the tool dispatcher ([plugin-tool-dispatcher.ts#L356](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-tool-dispatcher.ts#L356)) and host-service cleanup ([plugin-host-service-cleanup.ts#L37](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-host-service-cleanup.ts#L37)). Today they miss route-originated events. The implementation must confirm that their handlers are idempotent with the loader's own registrations (tool registration keyed by plugin key replaces, not duplicates) and add a regression assertion for each.

### 4.2 Per-plugin serializer

`serializer.run(pluginKey, kind, deadline, fn)` chains `fn` behind earlier work for the same key and gives it a **lease**. Rules:

- The key is the stable manifest id (`pluginKey`). Calls that address a row by id read the row once to get its key; the key of a row never changes. First install uses `manifest.id` from the validated package (4.6). Different keys never wait on each other.
- Queue wait counts against the operation deadline. If the lease is not granted before `queueWaitMs`, the call rejects with `plugin_lifecycle_busy` and has had no side effect.
- A lease is valid only while its holder runs. It becomes invalid on release and on deadline expiry. Every side-effecting step (row write, `startWorker`, registration, publishing `running`) checks `lease.assertActive()` first. A continuation that outlives its lease therefore cannot act.
- Reentrancy is explicit. Internal helpers take the lease as a parameter. Public methods take an optional `{ lease }`; if it is active and for the same key, they run inline instead of queueing. This resolves D11: `loadSingle` and `activatePlugin` receive the caller's lease through `PluginLoadSingleOptions` and pass it to `lifecycleManager.markError` / `load`. Implicit `AsyncLocalStorage` reentrancy is rejected because timers and child-process callbacks created inside a locked operation would inherit the context and bypass the queue.
- The lease is released only after `fn` settles, including after a deadline (4.8). The queue never hands the key to the next operation while the previous body can still reach a side effect.

Every lifecycle entry point goes through the serializer:

| Caller | Operation | Kind |
| --- | --- | --- |
| `POST /plugins/:id/disable` | `lifecycle.disable` | Q |
| `DELETE /plugins/:id` (soft) | `lifecycle.unload(id, false)` | Q |
| `DELETE /plugins/:id?purge=true` | `lifecycle.unload(id, true)` | Q, then existing hard delete (unchanged, not used by the consumer) |
| `POST /plugins/:id/enable` | `lifecycle.enable` | A |
| `POST /plugins/install` | persist + `lifecycle.load` (4.6) | A |
| `POST /plugins/:id/upgrade` | `lifecycle.upgrade` | Q then A in one lease |
| `markError`, `markUpgradePending` | as named | Q (worker stopped, row `error` / `upgrade_pending`) |
| Dev watcher reload | `lifecycle.restartWorker(id, { source: "watcher", epoch })` | R |
| `POST /plugins/:id/config` restart fallback | `lifecycle.restartWorker(id, { source: "config" })` | R |
| Startup `ensureBundledPlugins` and `loader.loadAll` | per-plugin `lifecycle.exclusive(pluginKey, ...)` | A |
| Worker crash retry | handle-internal, fenced by 4.3 | — |

### 4.3 Worker handle and manager fixes

These fix D5–D8 at the lowest seam, so the guarantees hold even for a caller that forgets the lifecycle queue.

- **Start token.** Each handle keeps `startToken`. `stopInternal` increments it. `startInternal` captures it before spawning and re-checks it after every await (initialize result, `killProcess`). On mismatch it kills its own child and returns without setting `running` or emitting `ready`.
- **Stop joins start.** `stopInternal` keeps a reference to the in-flight `startInternal` promise (from `start()`, `restart()` or a crash retry) and awaits it after signalling, so stop returns only after the start continuation has settled.
- **Intentional stop wins.** When initialize rejects because of an intentional stop, the final status is `stopped`, not `crashed`, and no crash retry is scheduled.
- **Crash retry is fenced.** `cancelPendingRestart` already clears an unfired timer. A fired timer captures `startToken` before calling `startInternal`. A stop in between bumps the token, and the stop joins the in-flight retry. A retry cannot outlive a stop.
- **Exit is proven.** `stopInternal` resolves only when the child has exited. If the child is still alive after SIGKILL, it rejects with `PluginWorkerStopError` and keeps status `stopping`. `manager.stopWorker` removes the registration only after `handle.stop()` resolves. On rejection the handle stays registered, `isRunning` is false, `call` rejects (status is not `running`/`starting`), and the lifecycle fences the plugin (4.7).
- **Stop every state.** Loader `teardownPluginRuntime` and lifecycle `stopWorkerIfRunning` stop whenever `workerManager.getWorker(id)` returns a handle, whatever its status (`starting`, `running`, `backoff`, `crashed`, `stopping`). Teardown errors propagate instead of being swallowed.

`startupLocks` stays as it is. Under the lifecycle queue, two starts for one plugin cannot be accepted concurrently, and the "already registered" error becomes a real invariant violation instead of a race outcome.

### 4.4 Generation epochs

`epochs[pluginId]` is bumped under the lease at the start of every Q and A operation. A reload request (kind R) records the epoch **synchronously when it is scheduled**, not when it gets the lease:

- the watcher reads the epoch when its debounce timer fires and passes it to `restartWorker`;
- the config route reads it when it decides to restart.

Under its lease, an R operation is a no-op that resolves `{ superseded: true }` if any of these holds: the epoch differs, the plugin is in `quiesced` or `fenced`, the row is not `ready`, or no handle is registered. Otherwise it runs a full deactivate and activate (4.2 lease, 4.3 teardown) through the runtime loader. The bare `handle.restart()` branch remains only for state-only harnesses without runtime services, and it also runs under the lease.

The watcher keeps using the app lifecycle. Because the context is shared (4.1), `restartWorker` reaches the same queue as the routes. To fix D3, the shared context also stores the runtime loader when the first lifecycle instance with one is built (the route instance, [app.ts#L963](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/app.ts#L963)). `activateReadyPlugin` and `deactivatePluginRuntime` use that loader, so a watcher reload takes the full deactivate/activate path (manifest re-read, migrations, new process) instead of the bare bounce.

The route instance is built before `ensureBundledPlugins` runs, so this would otherwise change the startup guarantee described at [app.ts#L1278](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/app.ts#L1276): the bundled `load()` would spawn a worker and `loadAll` would then spawn a second one. `ensureBundledPlugins` therefore calls `load(id, { activate: false })`, which records `ready` without activation, exactly as today, and `loadAll` stays the single spawner at boot. Matrix N2b covers the runtime reload branch and N12 the single spawn at startup.

### 4.5 Watcher withdrawal and draining

The dev watcher registers a synchronous withdrawer in the shared context: `withdraw(pluginId)` runs the existing `unwatchPlugin` (closes the chokidar watcher, clears the debounce timer, invalidates the pending registration generation). A Q operation bumps the epoch and calls it under its lease, before teardown. Ordering inside Q:

1. Acquire lease (waits for, and so drains, every earlier accepted operation on the key).
2. Bump epoch; add `quiesced`; call withdrawers. From here, no new reload is scheduled, and any already-scheduled one is superseded.
3. Write the target row state (`disabled`, or soft `uninstalled` via `registry.uninstall(id, false)`), so out-of-lease readers (data/bridge routes, startup retry) stop treating the plugin as `ready`.
4. Tear down runtime: scheduler unregister, event-bus clear, tool unregister, stop the handle in any state (4.3), dispose host services.
5. Verify: no handle registered for the id, no start in flight. If verification fails, the operation fails (4.7).
6. `unload` only: `cleanupInstallArtifacts` (unchanged behaviour).
7. Release the lease, then emit the existing domain events (`plugin.disabled` / `plugin.unloaded`, `plugin.status_changed`, `plugin.worker_stopped`). Events are emitted after release, so listeners never run inside the lease.

Writing the row before teardown (step 3) is deliberate. If teardown fails, the row already states the intent and the plugin stays fail-closed (4.7). Clients must not infer Q from the row; they get Q only from a successful response (section 6).

An accepted reload that already holds the lease when Q arrives is drained by step 1: Q waits for it to finish. A reload queued behind Q is superseded by step 2. A watcher timer that fires between step 2 and the close is superseded because it reads the new epoch, the row is no longer `ready`, and `quiesced` is set. A pending path lookup from `watchLocalPluginById` cannot re-register the watch, because the withdrawer bumped its registration generation, and the re-watch on `plugin.loaded`/`plugin.enabled` only happens after a later A.

### 4.6 Activation ordering and install

A operations (`enable`, `load`, the A half of `upgrade`, install):

1. Acquire lease (drains earlier work). Reject `plugin_lifecycle_fenced` if the plugin is fenced.
2. Bump epoch; remove from `quiesced`.
3. Transition the row to `ready` (existing behaviour).
4. `loader.loadSingle(id, { lease })` → `activatePlugin`: refresh manifest from the package, apply migrations, start the worker (awaits initialize), deliver stored config, sync and register jobs, register tools. Lease checks precede `startWorker` and the final registration.
5. On failure: tear down the partial generation (4.3) under the same lease, then `markError` inline via the lease. The response is an error (section 6).
6. Release; emit `plugin.loaded` / `plugin.enabled`. The watcher re-registers from these events, with `ignoreInitial: true` as today.

Install keeps the work that does not touch lifecycle state outside the lease, so a slow package fetch for one plugin cannot hold another operation's queue. Split `loader.installPlugin` into `prepareInstall(options)` (fetch, validate, optional repo autobuild, returns `DiscoveredPlugin`) and `persistInstall(discovered)` (the existing transaction). `installPlugin` stays as `persistInstall(await prepareInstall(options))` for other callers. The install route becomes:

```text
prepared = loader.prepareInstall(options)                     // outside lease
lifecycle.exclusive(prepared.manifest.id, "A", lease =>
  persistInstall(prepared)   // new row, or soft-deleted row reactivated (same id/data/config)
  lifecycle.load(id, { lease })                               // steps 2–5 above
)
```

A concurrent install or DELETE for the same key now waits for the lease. The registry's existing conflict check (row not `uninstalled`) still runs inside it.

### 4.7 Failure isolation

- **Queue timeout** (`plugin_lifecycle_busy`): nothing started, so retry is safe.
- **Activation failure or timeout**: step 4.6.5 runs. If its teardown fails, the plugin is fenced as below. Otherwise the plugin is `error`, no worker is registered, and the epoch has moved. This is Q-equivalent, but the response is still an error.
- **Stop not proven** (child alive after SIGKILL, or teardown threw): add `fenced[pluginId]`, keep `quiesced`, keep the handle registered, leave the row in its target state, and respond `plugin_quiescence_failed`. While fenced:
  - A operations and R operations are rejected or superseded, so the old generation cannot be joined by a new one;
  - Q operations (`disable`, soft `DELETE`) on the plugin are accepted and retry teardown; on success they clear the fence and respond with Q;
  - the handle's `exit` event clears the fence for the next operation, but does not establish Q on its own. Only a successful Q response does.

  The fence is in-memory. A server restart ends every child process with the parent, and startup activation only considers `ready` and `error` rows, so a `disabled`/`uninstalled` row stays quiet after restart.
- **Client timeout**: does not cancel the server operation and proves nothing. The supported recovery is to read the row and then re-issue the same idempotent Q operation (section 6).

### 4.8 Deadlines

Proposed server constants (each is a named constant with a test seam, not configuration):

| Bound | Value | Notes |
| --- | --- | --- |
| Queue wait | 30 s | counts toward the operation deadline |
| Operation body (after lease) | 60 s | A: initialize 15 s (existing `INITIALIZE_TIMEOUT_MS`) is inside it; startup config delivery and job/tool registration get the remaining time instead of the 30 s default RPC timeout per company |
| Stop | 17.5 s | existing: shutdown drain 10 s, 0.5 s, SIGTERM 5 s, SIGKILL 2 s; unchanged |
| Failure teardown after a deadline | ≤ 17.5 s | runs inside the same lease |

On deadline expiry the operation stops waiting and invalidates its lease. Its body is not preempted: an in-flight database or migration promise cannot be cancelled. The body keeps the queue until it settles, stops at its next lease check, runs failure teardown, and only then releases. The HTTP response is sent at the deadline with a timeout error. The worst-case response time is about 30 + 60 + 17.5 ≈ 108 s.

**Consumer budget check.** The consumer plan's 120 s per-plugin lifecycle budget covers this worst case. Its proposed **30 s cap per HTTP request does not**: a lifecycle write that has to wait behind a reload, or that has to stop a slow worker, can legitimately take longer than 30 s. With that cap, lost responses become the normal path. The #879 implementation should give lifecycle write requests the remaining lifecycle budget (at least 110 s) and keep the 30 s cap for reads. The 300 s build budget is unaffected: the build runs in the client before A, and the install route's repo autobuild only applies to repo-bundled paths with missing entrypoints ([plugin-loader.ts#L882](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-loader.ts#L882)), which the consumer's prior build already produced.

## 5. Watcher, config and crash call-site summary

| Path today | After |
| --- | --- |
| Watcher debounce → app `restartWorker` → bare `handle.restart()` | Watcher reads epoch → `restartWorker(id, { source: "watcher", epoch })` → shared queue → superseded or full reload via shared runtime loader |
| Route `disable`/`DELETE` events on route emitter only | Shared emitter; Q also calls watcher withdrawer synchronously before teardown |
| Config save → `restartWorker` (route instance, runtime branch, no exclusion) | Config route reads epoch → `restartWorker(id, { source: "config", epoch })`; superseded under Q |
| Crash backoff timer → `startInternal` on the same handle | Token-fenced and joined by stop (4.3); Q removes the handle |
| Startup `loadAll` retry of `error` rows | Per-plugin lease; skips plugins already `quiesced`/`fenced` in this process |

## 6. HTTP semantics

Routes and request shapes are unchanged. Error bodies keep `{ error }` and add a stable `code`.

| Request | Prior row state | Result |
| --- | --- | --- |
| `disable` | `ready` | 200 after Q |
| `disable` | `disabled` | **200 after re-establishing Q** (was 400). Runs steps 1–2 and 4–5 of 4.5, skipping the row write |
| `disable` | `installed`, `error`, `upgrade_pending`, `uninstalled` | 400 `invalid_transition`, unchanged; no side effects |
| soft `DELETE` | `ready`, `disabled`, `error`, `upgrade_pending`, `installed` | 200 after Q, row `uninstalled` (soft, preserved) |
| soft `DELETE` | `uninstalled` | **200 after re-establishing Q** (was 400 "already uninstalled") |
| `DELETE?purge=true` | any | Q first, then the existing hard-delete behaviour; unchanged otherwise |
| `enable` | `disabled`, `error`, `upgrade_pending` | 200 after A |
| `enable` | `ready` | 400, unchanged (never a silent restart) |
| `install` | none or soft `uninstalled` | 200 after A; soft-deleted row reused |
| `install` | any other existing row | 409 `already_installed` (status code made explicit; today 400 with the registry message) |
| any lifecycle write | lease not granted in time | 409 `plugin_lifecycle_busy`, no side effects |
| A or R | plugin fenced | 409 `plugin_lifecycle_fenced` |
| Q | teardown not proven | 500 `plugin_quiescence_failed`; row in target state; plugin fenced; retry the same Q |
| A | activation failed | 500 `plugin_activation_failed`; row `error`; worker torn down (or fenced) |
| any lifecycle write | operation deadline | 504 `plugin_lifecycle_timeout`; server keeps the lease until the body settles (4.8) |

Idempotent Q (`disable` on `disabled`, soft `DELETE` on `uninstalled`) is the only supported way to obtain Q after a lost response or a 5xx. A client must read the row first and choose the matching verb. It must not repeat a DELETE blindly against a pre-fix server, where that returns 400, and it must not escalate to `purge`.

Activity logging and `plugin.ui.updated` live events keep their current names. They are emitted only on 200.

## 7. Q is not observable as a single read

No endpoint reports "Q holds". Q is a property of a successful response, and it lasts until the next accepted A. Clients that need Q again (resume) re-issue idempotent Q. This is a deliberate design choice: adding a "quiesced" status endpoint would be a new route and would still race with the next accepted operation.

## 8. Version and capability evidence without a new endpoint

- **Server has the fix.** `GET /api/health` already reports `version`, `commit` and `serverInfo.git.fullSha`. The consumer treats Q/A as available only when the served full SHA equals the approved release SHA (a descendant of the #326 merge commit), recorded by the separately authorized release task (ai-team #904). There is no feature flag and no behavioural sniffing.
- **A holds for the target bundle.**
  - `GET /api/plugins/:id`: row `status=ready`, `version` and `packagePath` equal the target package.
  - `GET /api/plugins/:id/dashboard`: `worker.status=running` and a `pid`.
  - The plugin's existing data endpoint (`POST /api/plugins/:id/data/:key`, or the bridge equivalent) returns the bundle marker or version the consumer built.

  Version labels do not prove a same-version rebuild. In isolated tests the fixture worker's data handler returns a marker baked into its bundle (matrix N8).
- **Diagnostics are snapshots.** The dashboard reads one handle's state. It does not prove that no reload is pending, which is why A is defined by the response, not by sampling.

## 9. Deterministic isolated test matrix

All tests are server vitest files run in isolation: temp directories, fake or controllable clocks, deferred promises, real child processes from `server/src/__tests__/fixtures/*.cjs`, and an in-memory registry fake (`vi.mock` of `plugin-registry.js`, as in `plugin-lifecycle-restart.test.ts`) that keeps soft-deleted rows. No test calls a production API, a service unit or a real plugin directory, and none relies on `sleep`.

**Seams.** The highest seam is the real wiring of `pluginRoutes` (via `supertest`) plus the app-style lifecycle and `createPluginDevWatcher`, sharing one real `createPluginWorkerManager` and a runtime `pluginLoader`. The watcher's chokidar is replaced by an injectable emitter for event delivery only, and its path resolver is a deferred promise. Tests assert only through HTTP responses, the registry fake, `workerManager.getWorker`/`diagnostics`, the fixture's process events and data endpoint, and the order of recorded calls. They do not assert private queue internals.

**Fixture worker.** A new `plugin-worker-gated.cjs` (same JSON-RPC framing as `plugin-worker-delayed.cjs`). It connects to a Unix socket path from its env and holds `initialize` and `shutdown` replies until the test sends a release message. It can be told to ignore SIGTERM, and its `getData` returns `BUNDLE_MARKER` from its env. One gate per process gives deterministic interleavings.

**Red/green rule.** Tests use only seams that already exist at `5d427f93`, so the same file compiles against both trees. The implementation PR records two runs of the affected files:

- **red:** the test commit applied to a scratch worktree at `5d427f93a43d796a77f635e010993436d4141390`, with the failing assertions and call order saved;
- **green:** the fix head.

Rows marked "red" must fail on `5d427f93` for the stated reason. Rows marked "guard" pass on both and protect behaviour the fix must not break.

| # | Case (consumer matrix row) | Controlled interleaving | Expected on `5d427f93` | Expected on fix |
| --- | --- | --- | --- | --- |
| N1 | ready / starting | Plugin `ready`; watcher reload gated in `initialize` (handle `starting`); `DELETE` | red: DELETE 200 while handle stays `starting`; later install fails `Worker already registered (status: starting)` | DELETE waits for the reload to drain, then stops; 200 with no handle registered; install then succeeds once |
| N2a | DELETE / reload, bare branch | App lifecycle without loader (real app wiring) fires watcher reload; hold `handle.restart()` between stop and start; `DELETE`; release | red: worker `running` after DELETE 200 | reload either completes before Q (drained) or is superseded; after 200 no handle ever reappears (assert across release of every gate) |
| N2b | DELETE / reload, runtime branch | Route lifecycle `restartWorker` paused between `deactivatePluginRuntime` and `activateReadyPlugin`; `DELETE`; release | red: reactivates after uninstall | superseded; no `startWorker` call after DELETE accepted |
| N3 | app/route event chain | Route `disable`; then inject dist change into the app watcher; then resolve a previously pending path lookup | red: watcher still schedules `restartWorker`; stale lookup re-watches | withdrawer ran under Q; no restart scheduled; stale lookup ignored. A single-lifecycle mock does not satisfy this row |
| N4 | shared context | Build app and route lifecycles through the real wiring | red: separate emitters/queues | one emitter, one queue; route events reach watcher, tool dispatcher, host cleanup (idempotent registrations asserted) |
| N5 | DELETE / starting | `enable` gated in `initialize`; concurrent `DELETE`; then `install` | red: teardown skips `starting`; duplicate registration error | DELETE queues behind enable, then stops it; install starts exactly one new process; no leaked child (`exit` observed for every pid) |
| N6 | stale continuation | Stop a `starting` handle while initialize reply is in flight; release reply after stop signalled | red: status flips to `running` (or `crashed`) after stop | final `stopped`; no `ready` event; stop resolved after start settled |
| N7 | crash retry | Fixture exits unexpectedly → backoff; fire timer (fake clock) and gate the retry's initialize; `disable` | red: retry reaches `running` after disable 200 | disable joins the retry; final no handle; no further retries |
| N8 | same-version marker | Q via `disable`; rewrite bundle with marker `B` (same version), emit several dist events; `enable` | guard: today a stale reload during the build fails its `ready` check, so this row passes; it protects marker, row and data preservation through the new path | data endpoint returns `B`; row id, plugin data, config unchanged; no reload of `A` after enable |
| N9 | version change, preserved row | Soft `DELETE`; target package with higher version; `install` | guard: row id preserved; no upgrade route; no hard delete | same, plus install waited for A (worker `running` at response time) |
| N10 | first install | No row; two concurrent `install` of the same key | red on status code only: the loser gets 400 from the registry conflict | serialized by `manifest.id` (the second persist starts after the first A completes, by call order); one 200 after A, one 409 `already_installed`; one process |
| N11 | config restart | Worker without `configChanged`; config save triggers restart; `disable` arrives while restart holds the lease | red: restart and disable interleave | disable drains the restart, then Q; a config restart scheduled after Q is superseded |
| N12 | startup | `ensureBundledPlugins` → `load` without spawn; `loadAll` spawns once; route `disable` racing `loadAll` for the same plugin | guard: single spawn | single spawn; disable waits for that plugin's activation, then Q |
| N13 | stop failure | Fixture ignores shutdown and SIGTERM; SIGKILL blocked by a fake `kill` that keeps the process alive | red: 200 and registration deleted while the process lives | 500 `plugin_quiescence_failed`; handle kept; enable → 409 `plugin_lifecycle_fenced`; repeated `disable` after real exit → 200 Q |
| N14 | lost response | Client aborts the DELETE request mid-teardown | guard: server continues | server completes; follow-up `GET` shows `uninstalled`; soft `DELETE` again → 200 Q, no new side effects |
| N15 | idempotent Q | `disable` on `disabled`, soft `DELETE` on `uninstalled`, each with a stray `backoff` handle injected | red: 400, stray handle survives | 200; stray handle stopped; Q holds |
| N16 | queue bound | Hold a lease past `queueWaitMs` (fake clock); second write | red: no bound | 409 `plugin_lifecycle_busy`; no side effect from the second call |
| N17 | operation deadline | Gate `initialize` past the operation deadline | red: no deadline beyond initialize | 504 at deadline; lease held until failure teardown; queued Q then runs and returns 200 |
| N18 | consecutive events / second request | Many watcher events plus a concurrent `enable` | red: reloads overlap the enable | strict FIFO; at most one reload runs; stale epochs superseded; no unbounded queue (queue length bounded by the number of distinct accepted calls) |
| N19 | independent plugins | Plugin X gated in `initialize`; operate plugin Y | guard | Y completes while X is still held |
| N20 | reentrancy | Activation failure inside route `enable` calls `markError` | guard: no deadlock today because there is no lock | completes with 500 `plugin_activation_failed`, row `error`, no deadlock; a released lease passed later is rejected |

Coverage of the consumer's native rows: ready/starting (N1), DELETE/reload both paths (N2a, N2b), app/route events and stale lookups (N3, N4), DELETE/starting (N5), retries (N7, N18), stop failure (N13), lost response (N14), config restart (N11), same-version marker (N8), preserved soft-deleted row (N9), queue/deadline (N16, N17), independent plugins (N19). First install (N10), stale continuation (N6), idempotent Q (N15), startup (N12) and reentrancy (N20) are native additions. The consumer's Python-side rows (release lock, resume bookkeeping, build failure) belong to ai-team #879 and are out of scope here.

The host only runs these affected vitest files, within time bounds. Typecheck and build run in PR CI. No CLI or service tests run on the production host.

## 10. Delivery

- **#326 (implementation).** Against `develop`, with the red/green evidence above. Suggested order, either as one PR or as two:
  1. 4.3 worker handle/manager fixes (N5–N7, N13 at the manager level);
  2. 4.1–4.2 and 4.4–4.8 shared context, serializer, epochs, watcher, HTTP semantics (all other rows).

  The CTO decides the split. The second slice depends on the first.
- **Upstream.** The same fix is submitted to `paperclipai/paperclip` under the fork contribution workflow. The change will likely exceed the upstream small-PR guideline (about 300 lines across lifecycle, loader, worker manager, watcher and routes). If it cannot be split into independently mergeable upstream PRs, the upstream discussion note is drafted in the implementation task for the CTO to route.
- **Release and acceptance** (ai-team #904): separately authorized; independent acceptance checks the served SHA and section 8 evidence. Source approval does not authorize deployment.
- The consumer (#879) uses Q/A only after successful release acceptance. Nothing in this chain depends on the consumer or its coordination tasks.

## 11. Out of scope

New tables, routes, permissions, schedulers, maintenance leases or status endpoints; hard deletion as a recovery path; reproducing the race on a live instance; changing registry soft-delete retention; changing the consumer's release/pending semantics; ai-team #675 and its approval history.

## 12. Open points for review

- **Shared runtime loader for the watcher (4.4).** The app lifecycle gains the runtime branch through the shared context. Startup must still not spawn twice, so `ensureBundledPlugins` passes `{ activate: false }`. The reviewer should confirm this is preferable to keeping the bare branch under the lease. The bare branch would not re-read the manifest or re-apply migrations on reload, which the runtime branch exists to do.
- **Status-code changes (section 6).** 409 for already-installed, busy and fenced; 500/504 for failures; 200 for idempotent Q. These replace blanket 400s. The UI treats all non-2xx as errors. Upstream may prefer different codes; the `code` field is the stable contract.
- **Proposed constants (30 s / 60 s).** These are design values to be confirmed by N16/N17 and by the release acceptance, not deployed guarantees.

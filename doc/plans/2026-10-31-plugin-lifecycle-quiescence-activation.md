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

`pluginLifecycleManager(db, options)` obtains the context from a module-level `WeakMap<PluginWorkerManager, PluginLifecycleShared>` keyed by its `workerManager`. Production builds exactly one worker manager ([app.ts#L542](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/app.ts#L542)) and passes it to both the app and route lifecycle, so the two instances share emitter, queue and epochs with no new constructor parameter or wiring. An instance without a worker manager (state-only tests) gets a private context. A test asserts that the app and route instances built by the real wiring share the context (matrix N4a).

Sharing the emitter fixes D1. It also delivers route events to every other existing subscriber, which today miss route-originated events. Some of these subscribers change runtime state from inside the event, and some of them do it after an `await`. Idempotent replacement does not make that safe: a write that started for an old generation can land after a newer Q or A. 4.1.1 therefore moves ownership of these effects.

#### 4.1.1 Event subscribers and generation ownership

**Rule.** Runtime state for a plugin (worker handle, tools, job declarations, scheduler registration, host services, dev-watcher registration) changes only inside a lease, through lifecycle or loader code. Lifecycle events are notifications after the fact. An event subscriber does not start, register or re-register runtime state for a plugin. The runtime loader already performs every activating effect inside `activatePlugin` (job sync and scheduler registration at [plugin-loader.ts#L2421](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-loader.ts#L2421), tools at [#L2480](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-loader.ts#L2480)) and every deactivating effect inside teardown ([#L2182-L2194](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-loader.ts#L2182)). With the shared runtime loader (4.4) this holds for app and route operations alike, so the event copies are redundant.

**Event payloads** gain `epoch`: the generation of the operation that emitted them. The shared context exposes `isCurrentGeneration(pluginId, epoch)`: true when `epochs[pluginId] === epoch` and the plugin is neither `quiesced` nor `fenced`. It is synchronous.

**Emission order.** The serializer emits an operation's events and releases its lease in one synchronous turn, and grants the next lease in a later microtask. The synchronous part of every listener therefore runs after this operation's last side effect and before the next operation's first one.

| Subscriber | Today | After |
| --- | --- | --- |
| Tool dispatcher `plugin.enabled` ([plugin-tool-dispatcher.ts#L295](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-tool-dispatcher.ts#L295)) | fire-and-forget `registerFromDb`: awaits `getById`, then registers with no status or generation check | No registration from the event. The loader registers tools under the A lease. Boot `initialize()` ([app.ts#L1262](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/app.ts#L1262), not awaited) is the only remaining read-then-register path: it captures each plugin's epoch before its read and registers only if `isCurrentGeneration` still holds, in the same synchronous turn as the register call |
| Tool dispatcher `plugin.disabled` / `plugin.unloaded` | synchronous unregister | Kept. Synchronous, runs before the next grant, and repeats the loader's in-lease unregister |
| Job coordinator `plugin.loaded` ([plugin-job-coordinator.ts#L112](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-job-coordinator.ts#L112)) | awaits `getById`, then `syncJobDeclarations` (DB write) and `scheduler.registerPlugin` | Removed. The loader does both under the A lease |
| Job coordinator `plugin.disabled` / `plugin.unloaded` | async `scheduler.unregisterPlugin`; `deleteAllJobs` when `removeData` | Unregister removed (the loader does it in teardown). The purge `deleteAllJobs` moves into the `unload(id, true)` body under the lease, before release |
| Host-service cleanup `plugin.worker_stopped` / `plugin.unloaded` ([plugin-host-service-cleanup.ts#L37](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-host-service-cleanup.ts#L37)) | synchronous dispose by `pluginId` | Kept, with a guard: dispose only when `payload.epoch === epochs[pluginId]`. Synchronous; with the emission order it cannot dispose services that a later A created |
| Dev watcher `plugin.loaded` / `plugin.enabled` ([plugin-dev-watcher.ts#L372](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-dev-watcher.ts#L372)) | async `watchLocalPluginById`: path lookup, then watch | Kept. The handler captures `payload.epoch`. After the lookup resolves, and with no `await` between the check and the watch call, it watches only if `isCurrentGeneration(pluginId, epoch)` holds and its registration generation is current (4.5). Otherwise it drops the result. The watch is not runtime state of the worker, and a later reload it schedules is still an R operation checked again under the lease (4.4) |
| Dev watcher `plugin.disabled` / `plugin.unloaded` | synchronous unwatch | Kept. Q already called the withdrawer under the lease (4.5) |
| Lifecycle delivery ([plugin-lifecycle-delivery.ts#L147](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-lifecycle-delivery.ts#L147)) | wakes delivery and re-reads which plugins need the LISTEN channel | Unchanged. It changes no plugin runtime state. Its re-read is internally serialized and reads the current rows, and the next event re-evaluates it |

**What Q drains.** Q does not wait for subscriber work, because no subscriber can activate anything after 4.1.1. The only asynchronous subscriber left (the watcher lookup) ends in a synchronous generation check, so a lookup that resolves after Q, or after the next A of a different generation, has no effect. A stale subscriber result can never overwrite a newer generation: the check and the write are in the same synchronous turn, and every Q and A bumps the epoch.

**Old manifest after the next A.** Case: A1 emits `plugin.enabled` (epoch 1). A Q and then A2 with manifest B run (epochs 2 and 3). A subscriber result for epoch 1 now resolves. Tools and jobs: there is no subscriber write any more; A2 registered B under its lease. Watcher: the epoch-1 lookup fails the check and is dropped; A2's own event registers the watch for the current path.

Matrix rows N4a and N4b cover this section.

### 4.2 Per-plugin serializer

`serializer.run(pluginKey, kind, deadline, fn)` chains `fn` behind earlier work for the same key and gives it a **lease**. Rules:

- The key is the stable manifest id (`pluginKey`). Calls that address a row by id read the row once to get its key; the key of a row never changes. First install uses `manifest.id` from the validated package (4.6). Different keys never wait on each other.
- Queue wait counts against the response deadline (4.8). If the lease is not granted before `queueWaitMs`, the call rejects with `plugin_lifecycle_busy` and has had no side effect.
- A lease separates two capabilities: **activation** and **cleanup**. Its state is `active` → `expired` (response deadline passed) → `released`, and it never goes back.
  - `lease.assertActive()` passes only in `active`. It guards every activating side effect: a row write to `ready`, `startWorker`, publishing `running`, tool, job or scheduler registration, host-service creation, delivering config, and every reentrant A-kind call.
  - `lease.assertCleanup()` passes in `active` and `expired`. It guards deactivating side effects only: stopping a handle in any state, unregistering tools, jobs and scheduler entries, disposing host services, writing a row to `error`, `disabled` or `uninstalled`, and setting `fenced`/`quiesced`.
  - Both throw after `released`. A continuation that outlives its lease therefore cannot act at all, and a continuation that outlives the deadline can only take the plugin down.
- Reentrancy is explicit. Internal helpers take the lease as a parameter. Public methods take an optional `{ lease }` for the same key and then run inline instead of queueing. A-kind methods (`load`, `enable`, `restartWorker`, the A half of `upgrade`) accept only an `active` lease. Q-kind methods (`disable`, `unload`, `markError`, `markUpgradePending`) accept `active` or `expired`, and inside them only cleanup-guarded effects run. This resolves D11: `loadSingle` and `activatePlugin` receive the caller's lease through `PluginLoadSingleOptions` and pass it to `lifecycleManager.markError` / `load`. After expiry, `markError(id, msg, { lease })` runs inline with cleanup capability, so it never queues behind its own unfinished operation. Implicit `AsyncLocalStorage` reentrancy is rejected because timers and child-process callbacks created inside a locked operation would inherit the context and bypass the queue.
- The lease is released only after `fn` settles and, after an expiry, after the expiry cleanup has settled (4.7, 4.8). The queue never hands the key to the next operation while the previous body or its cleanup can still reach a side effect.

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
7. Emit the existing domain events (`plugin.disabled` / `plugin.unloaded`, `plugin.status_changed`, `plugin.worker_stopped`, each with `epoch`) and release the lease in one synchronous turn (4.1.1). Listeners never run inside the lease, and their synchronous part runs before the next operation starts.

Writing the row before teardown (step 3) is deliberate. If teardown fails, the row already states the intent and the plugin stays fail-closed (4.7). Clients must not infer Q from the row; they get Q only from a successful response (section 6).

An accepted reload that already holds the lease when Q arrives is drained by step 1: Q waits for it to finish. A reload queued behind Q is superseded by step 2. A watcher timer that fires between step 2 and the close is superseded because it reads the new epoch, the row is no longer `ready`, and `quiesced` is set. A pending path lookup from `watchLocalPluginById` cannot re-register the watch, because the withdrawer bumped its registration generation, and the re-watch on `plugin.loaded`/`plugin.enabled` only happens after a later A.

### 4.6 Activation ordering and install

A operations (`enable`, `load`, the A half of `upgrade`, install):

1. Acquire lease (drains earlier work). Reject `plugin_lifecycle_fenced` if the plugin is fenced.
2. Bump epoch; remove from `quiesced`.
3. Transition the row to `ready` (existing behaviour).
4. `loader.loadSingle(id, { lease })` → `activatePlugin`: refresh manifest from the package, apply migrations, start the worker (awaits initialize), deliver stored config, sync and register jobs, register tools. `lease.assertActive()` precedes every activating step listed in 4.2, including `startWorker`, config delivery and each registration.
5. On failure before the deadline: tear down the partial generation (4.3) under the same lease, then `markError(id, msg, { lease })` inline. The response is an error (section 6). Failure after the deadline follows 4.7 "Deadline expiry".
6. Emit `plugin.loaded` / `plugin.enabled` with `epoch` and release, in one synchronous turn. The watcher re-registers from these events, with `ignoreInitial: true` as today, under the generation check of 4.1.1.

Install keeps the work that does not touch lifecycle state outside the lease, so a slow package fetch for one plugin cannot hold another operation's queue. Split `loader.installPlugin` into `prepareInstall(options)` (fetch, validate, optional repo autobuild, returns `DiscoveredPlugin`) and `persistInstall(discovered)` (the existing transaction). `installPlugin` stays as `persistInstall(await prepareInstall(options))` for other callers. The install route becomes:

```text
prepared = loader.prepareInstall(options)                     // outside lease
lifecycle.exclusive(prepared.manifest.id, "A", lease =>
  persistInstall(prepared)   // new row, or soft-deleted row reactivated (same id/data/config)
  lifecycle.load(id, { lease })                               // steps 2–5 above
)
```

A concurrent install or DELETE for the same key now waits for the lease. The registry's existing conflict check (row not `uninstalled`) still runs inside it.

`prepareInstall` runs before the lease but inside the request's response deadline (4.8). It receives an `AbortSignal` that fires at the deadline: the package fetch is aborted and the optional autobuild child process group is killed. If prepare settles after the deadline, its result is discarded before `exclusive` is called, so it never persists a row or reaches the queue. Files that an aborted prepare left on disk are handled exactly as for a failed install today.

### 4.7 Failure isolation

- **Queue timeout** (`plugin_lifecycle_busy`): nothing started, so retry is safe.
- **Activation failure before the deadline**: step 4.6.5 runs with the active lease. If its teardown fails, the plugin is fenced as below. Otherwise the plugin is `error`, no worker is registered, and the epoch has moved. This is Q-equivalent, but the response is still an error.
- **Deadline expiry.** At the response deadline the serializer, in one synchronous turn, moves the lease to `expired` and sends the 504 (4.8). From then on:
  1. The body keeps running until it settles. It cannot be preempted: an in-flight database or migration promise cannot be cancelled. Its next `assertActive()` throws `LeaseExpiredError`, so it starts nothing new. A write that was already in flight (for example the row write to `ready`) may still land; it lands before step 2 starts.
  2. After the body settles, the serializer runs the operation's **expiry cleanup** with the cleanup capability, under the same lease and without queueing: stop any registered handle in any state (4.3; this bumps the start token, so a late initialize kills its own child), unregister tools, jobs and scheduler entries, dispose host services. For an A or R operation it then calls `markError(id, "lifecycle deadline expired", { lease })` inline; for a Q operation it writes the Q target row if step 4.5.3 had not run yet. It bumps the epoch and adds `quiesced` in both cases.
  3. If cleanup succeeds: no handle is registered, the row is `error` (A/R) or the Q target (Q), and the lease is released. The plugin is quiet, but the client only has a 504. It obtains Q by re-issuing idempotent Q (section 6).
  4. If cleanup fails (the stop is not proven, a teardown step throws, or the row write throws): set `fenced[pluginId]` and keep `quiesced`. Both are in-memory and set synchronously, so they cannot fail. Keep the handle registered. The row keeps the last write that succeeded; it can still read `ready` if the `error` write failed, which is why A and R are gated by the in-memory fence and not by the row. Then release the lease.
  5. Cleanup has no time limit of its own beyond the stop bounds of 4.3. While it or the body is still unsettled, the lease stays held and later operations on the key get `plugin_lifecycle_busy` after `queueWaitMs`. The lease is not released early, because a late cleanup write could still overwrite the row of a newer operation.

  A stale continuation cannot use the cleanup capability to come back: cleanup only takes the plugin down, the epoch has moved, and after release both capabilities throw.
- **Stop not proven** in a Q operation (child alive after SIGKILL, or teardown threw): add `fenced[pluginId]`, keep `quiesced`, keep the handle registered, leave the row in its target state, and respond `plugin_quiescence_failed`.
- **While fenced**:
  - A operations and R operations are rejected or superseded, so the old generation cannot be joined by a new one;
  - Q operations (`disable`, soft `DELETE`) on the plugin are accepted and retry the teardown and the row write; on success they clear the fence and respond with Q;
  - the handle's `exit` event clears the fence for the next operation, but does not establish Q on its own. Only a successful Q response does.

  The fence is in-memory. A server restart ends every child process with the parent. Startup activation only considers `ready` and `error` rows, so a `disabled`/`uninstalled` row stays quiet after restart. A row left `ready` or `error` by a failed cleanup is activated by startup as today; Q was never reported for it, so this breaks no contract.
- **Client timeout**: does not cancel the server operation and proves nothing. The supported recovery is to read the row and then re-issue the same idempotent Q operation (section 6).

### 4.8 Deadlines

Every bound is a named server constant. Tests replace them through an optional `lifecycleTimings` field of the lifecycle and route factory options (a test seam, not configuration). On `5d427f93` the field is ignored, which is what makes the deadline rows red there.

| Phase | Starts | Ends | Bound | At expiry |
| --- | --- | --- | --- | --- |
| Admission | request arrival `T0` | the plugin key is known (one row read, or the validated manifest for install) | inside the response deadline | 504, no side effect |
| Prepare (install only) | after admission | `prepareInstall` settles | inside the response deadline; aborted at it | 504 with `phase: "prepare"`; nothing persisted; a late result is discarded (4.6) |
| Queue wait | `exclusive` is called | lease granted | `queueWaitMs` = 15 s, or less if the response deadline comes first | 409 `plugin_lifecycle_busy` (or 504 if the response deadline came first); no side effect |
| Body | lease granted | body settles | until the response deadline. A: `initialize` keeps its existing 15 s (`INITIALIZE_TIMEOUT_MS`); startup config delivery and job/tool registration get the remaining time instead of the 30 s default RPC timeout per company | lease `expired`, 504 `plugin_lifecycle_timeout` |
| **Response deadline** | `T0` | response sent | `responseDeadlineMs` = 60 s, a timer, for every lifecycle write (Q, A, install, and the config route when it restarts the worker) | the HTTP response is always sent by `T0 + 60 s` |
| Settlement | 504 sent | body settled and expiry cleanup settled (4.7) | stop bounds of 4.3 (17.5 s) after the body settles; **no upper bound** while a database or migration promise has not settled | key stays busy; the plugin ends `error`/Q target, or fenced |
| Recovery | client decides to recover | idempotent Q response | a new request with its own response deadline | 409 busy if settlement still holds the key after `queueWaitMs` |

These are different quantities and must not be added into one completion bound. The server guarantees a **response** within 60 s of arrival. It does not guarantee that the operation's effects have **settled** within any fixed time. It guarantees that, until they settle, no other lifecycle operation for the key runs.

**Consumer budget.** The consumer plan (ai-team #892) gives each plugin one monotonic lifecycle budget `B = 120 s`, shared by Q, A, config and diagnostics. Each HTTP request is capped at `min(remaining, 30 s)`. The build has its own 300 s budget between Q and A, so it is not in `B`. With the bounds above, from the remaining budget:

| Step | Healthy, no contention | Server worst case without failure | At consumer expiry |
| --- | --- | --- | --- |
| Q (`disable`/soft `DELETE`) | queue 0; graceful shutdown, typically under a few seconds | queue up to 15 s behind a reload or config restart, then stop up to 17.5 s, plus row and teardown writes: about 33 s or more; up to 60 s | The 30 s cap can expire while the server still succeeds. The outcome is unknown, so the consumer keeps pending and later re-reads the row and re-issues idempotent Q |
| A (`enable`/install) | initialize and registration, a few seconds | queue up to 15 s, initialize up to 15 s, then config delivery and registration: up to 60 s | A is unknown. The plugin may still be activating or may end `error`. The consumer keeps pending and resumes through Q→A |
| config | one write, maybe an R restart under the lease | an R restart can take up to 60 s | A is proven, config is unknown; resume follows the consumer's existing rule |
| diagnostics | a few 2 s reads | the reads are not lifecycle writes and do not queue | — |
| **Sum** | far below 120 s | Q 60 + A 60 = 120 s exhausts `B` before config | bounded failure with pending kept |

Conclusion: the native bounds give the consumer a **bounded failure**, not a guaranteed success within 120 s. In the healthy case everything fits in `B` with the 30 s cap. In contended or slow cases, a single successful server response can take longer than 30 s, and Q plus A can use the whole of `B`. The earlier statement of this plan that "120 s is enough" was not proven and is withdrawn. Whether the consumer raises its per-request cap for lifecycle writes (for example to `min(remaining, 60 s)`), raises `B`, or accepts more bounded failures is a decision for ai-team #879 under its own review. This plan only fixes the server-side numbers.

The 300 s build budget is unaffected: the build runs in the client before A, and the install route's repo autobuild only applies to repo-bundled paths with missing entrypoints ([plugin-loader.ts#L882](https://github.com/phenix3443/paperclip/blob/5d427f93a43d796a77f635e010993436d4141390/server/src/services/plugin-loader.ts#L882)), which the consumer's prior build already produced. If autobuild does run, it is part of the install request's response deadline.

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
| any lifecycle write | response deadline (60 s from arrival) | 504 `plugin_lifecycle_timeout`; the server keeps the lease until the body and its expiry cleanup settle, then the plugin is `error`/Q target or fenced (4.7) |

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

**Red/green rule.** Tests use only seams that already exist at `5d427f93`, plus the optional `lifecycleTimings` field (4.8), which the old tree ignores. The same file therefore runs against both trees. The implementation PR records two runs of the affected files:

- **red:** the test commit applied to a scratch worktree at `5d427f93a43d796a77f635e010993436d4141390`, with the failing assertions and call order saved;
- **green:** the fix head.

Rows marked "red" must fail on `5d427f93` for the stated reason. Rows marked "guard" pass on both and protect behaviour the fix must not break.

| # | Case (consumer matrix row) | Controlled interleaving | Expected on `5d427f93` | Expected on fix |
| --- | --- | --- | --- | --- |
| N1 | ready / starting | Plugin `ready`; watcher reload gated in `initialize` (handle `starting`); `DELETE` | red: DELETE 200 while handle stays `starting`; later install fails `Worker already registered (status: starting)` | DELETE waits for the reload to drain, then stops; 200 with no handle registered; install then succeeds once |
| N2a | DELETE / reload, bare branch | App lifecycle without loader (real app wiring) fires watcher reload; hold `handle.restart()` between stop and start; `DELETE`; release | red: worker `running` after DELETE 200 | reload either completes before Q (drained) or is superseded; after 200 no handle ever reappears (assert across release of every gate) |
| N2b | DELETE / reload, runtime branch | Route lifecycle `restartWorker` paused between `deactivatePluginRuntime` and `activateReadyPlugin`; `DELETE`; release | red: reactivates after uninstall | superseded; no `startWorker` call after DELETE accepted |
| N3 | app/route event chain | Route `disable`; then inject dist change into the app watcher; then resolve a previously pending path lookup | red: watcher still schedules `restartWorker`; stale lookup re-watches | withdrawer ran under Q; no restart scheduled; stale lookup ignored. A single-lifecycle mock does not satisfy this row |
| N4a | shared context | Build app and route lifecycles through the real wiring | red: separate emitters/queues | one emitter, one queue; route events reach watcher, tool dispatcher, job coordinator and host cleanup |
| N4b | stale subscriber work | Tool dispatcher and job coordinator subscribed to the app lifecycle (real wiring). `enable` through the app instance; the registry fake holds every `getById` issued by subscribers. (i) Complete `disable` (Q), then release the held reads. (ii) Variant: after Q, `install` a package with manifest B (next A), then release the held reads of the old generation. Watcher lookups held the same way | red on (i) through the app instance: tools of the disabled plugin are registered again after release (the reviewer's interleaving: unregister, disable done, register) | (i) no tools, no scheduler registration, no job-declaration write after Q; (ii) tools, jobs and watch path are B's only; no write from the old generation in the recorded call order |
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
| N17a | deadline after initialize | `lifecycleTimings` sets a short response deadline and a longer initialize timeout. `enable`; `initialize` succeeds; the fixture holds the first post-initialize RPC (startup config delivery) past the response deadline; then release it | red: no deadline; the request waits and the worker ends `running` | 504 at the deadline; after release no tool, job or scheduler registration happens; the expiry cleanup stops the worker; row `error`; a `disable` sent after the 504 waits for release, then 200 Q |
| N17b | late DB write | `enable`; the registry fake holds the row write to `ready` past the deadline, then resolves it | red: no deadline | 504 at the deadline; the late `ready` write lands, then cleanup writes `error`; `startWorker` is never called (its `assertActive` fails); no handle registered at the end |
| N17c | cleanup fails | As N17a, plus the fixture ignores shutdown and SIGTERM, the fake `kill` keeps it alive, and the registry fake rejects the `error` write | red: no deadline, no fence | 504; plugin fenced and `quiesced`; row still `ready`; `enable` → 409 `plugin_lifecycle_fenced`; a watcher event is superseded; `disable` after the real exit → 200 Q and the fence is cleared |
| N17d | settlement holds the key | As N17b, but the held write is released only at the end of the test | red: no bound | 504 for the first request; a second write on the same key → 409 `plugin_lifecycle_busy` after `queueWaitMs`, with no side effect; a write on another key completes (as N19) |
| N18 | consecutive events / second request | Many watcher events plus a concurrent `enable` | red: reloads overlap the enable | strict FIFO; at most one reload runs; stale epochs superseded; no unbounded queue (queue length bounded by the number of distinct accepted calls) |
| N19 | independent plugins | Plugin X gated in `initialize`; operate plugin Y | guard | Y completes while X is still held |
| N20a | reentrancy | Activation failure inside route `enable` calls `markError` | guard: no deadlock today because there is no lock | completes with 500 `plugin_activation_failed`, row `error`, no deadlock |
| N20b | lease capabilities | During the N17a settlement, capture the expired lease from the `PluginLoadSingleOptions` seen by a spy on `loader.loadSingle`; pass it to `markError`, then to `enable`/`load`; after release, pass it to both again | red: no lease | `markError` with the expired lease runs inline (no queueing, no deadlock); `enable`/`load` with it reject `LeaseExpiredError` and start nothing; after release, both reject |
| N21 | prepare stuck | `install` with `prepareInstall` held by a deferred past the response deadline (fake fetch or autobuild); a concurrent `disable` of another plugin and a soft `DELETE` of the same key | red: no deadline | 504 with `phase: "prepare"` at the deadline; the abort signal fired; when the deferred resolves later, no row is written and nothing is queued; the other requests are not delayed by the held prepare |
| N22 | Q uses most of the budget, then A expires | `lifecycleTimings` scales the bounds down. `disable` waits behind a held reload until just before `queueWaitMs`, then completes (200 Q, response time recorded). `enable` follows; `initialize` is held past A's response deadline | red: no deadline | Q 200 within its own deadline; A 504 at `T0(A) + responseDeadlineMs`, independent of how long Q took; after settlement the row is `error` with no handle; an idempotent `disable` then returns 200 Q. The test records both response times so the consumer can check its budget arithmetic (4.8) |

Coverage of the consumer's native rows: ready/starting (N1), DELETE/reload both paths (N2a, N2b), app/route events, stale subscriber work and stale lookups (N3, N4a, N4b), DELETE/starting (N5), retries (N7, N18), stop failure (N13), lost response (N14), config restart (N11), same-version marker (N8), preserved soft-deleted row (N9), queue/deadline (N16, N17a–N17d, N21, N22), independent plugins (N19). First install (N10), stale continuation (N6), idempotent Q (N15), startup (N12), reentrancy and lease capabilities (N20a, N20b) are native additions. The consumer's Python-side rows (release lock, resume bookkeeping, build failure) belong to ai-team #879 and are out of scope here.

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
- **Proposed constants (15 s queue wait / 60 s response deadline).** These are design values to be confirmed by N16, N17a–N17d, N21, N22 and by the release acceptance, not deployed guarantees. The consumer's per-request cap is decided in ai-team #879 (4.8).
- **Event subscribers (4.1.1).** Removing the activating event handlers of the tool dispatcher and the job coordinator is a behaviour change for any caller that relied on events to register tools or jobs without the runtime loader. In production every lifecycle instance reaches the shared runtime loader, so no such caller remains.

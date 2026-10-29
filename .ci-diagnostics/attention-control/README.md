# Attention cleanup collector repair

This is an isolated fork diagnostic, not an A1 runtime change. Issue #189 is the
contract. No new paired experiment is authorized by this revision (budget zero).
The original pair consumed both samples and produced incomplete evidence. The
old approval covers only `9fbf012ef4692d774407923e0e8f1a27f7753aa3`.

## Pinned reporter interface

Vitest 5.0.3 tag resolves to `33cadea62e8763c455c7fca38d9ab1dda87c5f75`.
Official sources inspected:

- [Reporter interface](https://github.com/vitest-dev/vitest/blob/33cadea62e8763c455c7fca38d9ab1dda87c5f75/packages/vitest/src/node/types/reporter.ts): `onTestRunEnd(modules, unhandledErrors, reason)`.
- [Reported tasks](https://github.com/vitest-dev/vitest/blob/33cadea62e8763c455c7fca38d9ab1dda87c5f75/packages/vitest/src/node/reporters/reported-tasks.ts): `TestModule.moduleId`, `state()`, `errors()`, `children.allTests()`, and `TestCase.result()` / `diagnostic()`.
- [JSON reporter](https://github.com/vitest-dev/vitest/blob/33cadea62e8763c455c7fca38d9ab1dda87c5f75/packages/vitest/src/node/reporters/json.ts): inspected as a reference; the repair does not discover a JSON document in console output.

`reporter.mjs` projects callback values before writing them. It never persists
console text, titles, stacks or error messages. Errors become fixed categories.
The runner ingests that bounded schema and writes a fixed collection code plus
actual/expected module counts. Unknown fields, pending states, wrong inventory,
missing or malformed output remain incomplete. A complete failed-test report is
inspectable evidence; it cannot make the diagnostic job succeed.

## Sampler contract

`snapshot.mjs` performs one read-only statement. It discovers current-database
PIDs and their transitive blocking PIDs, aggregates lock type/mode/granted counts
per PID before joining activity, then returns at most 128 PID records and 32
lock groups per PID. Totals are computed before limiting. A blocker missing from
the records (including a prepared-transaction PID 0), unknown activity state,
truncated PID/group set or query error prevents a completeness claim. Repeated
locks contribute counts instead of consuming activity slots. This captures
PostgreSQL-reported heavyweight lock relationships at the sampling instant;
it cannot prove absence of waits between samples or diagnose CPU causality.

The observer keeps the original 5-second threshold, 1-second interval/query
limit, 29-second deadline and client/timer cleanup. It does not cancel or retry
the test's delete. Source tests, manifest, observation patch, worker/isolation
settings, runtime timeouts, Node/pnpm pins, schema and dependencies are unchanged.

The previous job's runner-initialization banner and process `ImageVersion`
environment field disagree. They are separately sourced channels in the saved
job log and `environment.json`; their mapping to a concrete image is unresolved.
Preserve both and limit comparability. Matching software versions alone does not
establish an identical image or eliminate A1 effects.

## Small fixture checks

Run with existing installed dependencies; do not install or edit lockfiles:

```
timeout 60s node --test .ci-diagnostics/attention-control/collector.test.mjs
ATTENTION_FIXTURE_DEPENDENCIES=/path/to/packages/db timeout 60s node --test .ci-diagnostics/attention-control/integration.test.mjs
```

The integration fixture uses only one deliberately failing synthetic Vitest
assertion to check actual 5.0.3 callback compatibility and redaction, plus a
small disposable PostgreSQL cluster (16 MiB shared buffers, 10 connections) to
verify >200 locks and actual blocker coverage. It is not the 103-file workload.
The database is stopped before its directory is deleted. Fixtures inspect safe
metadata through reporter/output and SQL/observer interfaces; raw test console
is held in memory only. Local checks on a different Node version are preparation
evidence, not a substitute for the pinned paired environment or CI build.

Independent review must bind the complete new revision. Approval alone adds no
experiment budget. A further pair requires a separate explicit budget decision.

# Preserve shallow history in native SSH workspace transfer

Status: proposal for independent review. Issue: [#17](https://github.com/phenix3443/paperclip/issues/17).
This document authorizes no implementation, rollout, workspace repair, or business retry.

## Problem and scope

A reviewer can fail before its provider starts because the SSH Git transfer loses
shallow metadata. The sender has a valid shallow snapshot. The receiving repository
tries to traverse parents which the sender intentionally does not have.

Choose a versioned envelope around the existing bundle, with isolated validation
and additive publication. Keep the public `prepareWorkspaceForSshExecution` and
`restoreWorkspaceFromSshExecution` interface. The adapter-utils SSH Git transfer
module owns framing, shallow semantics, locking, and temporary refs. Heartbeat,
review decisions, recovery actions, database contracts, and UI do not change.
The highest test seam remains public prepare/restore through the real SSH fixture.

Users need these outcomes:

1. A shallow workspace can start remote execution without acquiring more history.
2. A remote commit can return with its required shallow metadata.
3. Existing target refs and their visible history survive either direction.
4. Concurrent transfers cannot exchange snapshots or remove another transfer's ref.
5. A failed transfer reports failure and leaves existing Git history readable.
6. A later authorized recovery keeps the original reviewer and review history.

## Fixed evidence and limits

Source base, remote `develop`, and deployed `/api/health` commit were independently
read as `94d523ac7b065eed0973c7da761f078c8b783ca4` on 2026-10-23
(Asia/Shanghai). Health reports version `0.3.1`. The installed adapter-utils package
also reports `0.3.1`; its `dist/ssh.js` contains the same bundle/fetch paths.
The local Git reports `2.56.0`. This is source/deployment identification, not a
compatibility test or permission to deploy that commit.

Fixed source links:

- [Import](https://github.com/phenix3443/paperclip/blob/94d523ac7b065eed0973c7da761f078c8b783ca4/packages/adapter-utils/src/ssh.ts#L762): a UUID ref pins the source commit; bundle creation is at line 779; target fetch is at line 801. No shallow data travels. The remote trap removes the bundle, but its temporary ref is removed only after checkout/reset/clean succeed.
- [Export](https://github.com/phenix3443/paperclip/blob/94d523ac7b065eed0973c7da761f078c8b783ca4/packages/adapter-utils/src/ssh.ts#L845): the fixed `refs/paperclip/ssh-sync/export` is written before cleanup is armed. The target fetch is at line 894. No shallow data travels.
- [Restore integration](https://github.com/phenix3443/paperclip/blob/94d523ac7b065eed0973c7da761f078c8b783ca4/packages/adapter-utils/src/ssh.ts#L1753): baseline restore retains a unique imported ref until history/file integration finishes, then removes it in `finally`. Preserve that lifetime.
- [Fixture](https://github.com/phenix3443/paperclip/blob/94d523ac7b065eed0973c7da761f078c8b783ca4/packages/adapter-utils/src/ssh-fixture.test.ts#L747): current round-trip covers complete history, dirty tracked files, and untracked files. The concurrency test at line 806 uses different remote directories. It does not prove fixed-export-ref safety in one remote directory.

Prior isolated diagnostic evidence showed that a reconstructed shallow-source
bundle fails in an empty bare target, and the same bundle succeeds after supplying
the source shallow file. The original transmitted bundle had already been deleted;
there is no original-package checksum. This proposal reuses that evidence and does
not rerun it or treat direct shallow-file copying as a general repair algorithm.

An additional failed reviewer run was read with all five events. It reports missing
parent `9ba99d51f93ee97c9588e17bf617c399d8ab4a69`, traversal failure at
`24534040b39924f47ded04a7279b3ba6e104d775`, and insufficient bundle objects.
The source objects, source shallow file, and original package for that run were not
inspected. The symptoms agree; the run alone does not prove the same root cause.
Private diagnostic record IDs and exact report revisions stay in the task handoff.

Upstream contracts:

- [Git shallow](https://git-scm.com/docs/shallow) defines the shallow file as traversal roots. `fsck` respects it, so a passing `fsck` cannot prove that a new declaration did not hide history.
- [Bundle format](https://git-scm.com/docs/bundle-format#_note_on_the_shallow_clone_and_a_git_bundle) distinguishes prerequisites from shallow roots. Bundle v2 does not represent a shallow repository.
- [Fetch](https://git-scm.com/docs/git-fetch#Documentation/git-fetch.txt---update-shallow) permits shallow updates when fetching from a shallow repository. Adding that flag cannot reconstruct metadata absent from the transported bundle.
- [Index-pack](https://git-scm.com/docs/git-index-pack) distinguishes object validation from connectivity and documents `.keep` protection. [Update-ref](https://git-scm.com/docs/git-update-ref) provides conditional updates, but no transaction across shallow, refs, index, and worktree.

## Selected transport contract

Use one internal `writeSnapshotEnvelope` / `receiveSnapshotEnvelope` implementation
concept for both directions, expressed in controller code and its generated remote
shell script. These are private module helpers, not new public exports or a generic
transport framework. Inputs are a pinned commit, repository path, operation UUID,
and existing cancellation/deadline. Receive returns the validated imported OID;
ref ownership remains with the existing caller until integration ends. Map the
source transfer ref to the existing caller-owned unique imported ref; these names
need not match, but each must be generated and checked for this operation.

The byte stream has the following fixed ASCII lines, followed immediately by binary
bundle bytes. Values shown in angle brackets are placeholders, not literal syntax:

```text
PAPERCLIP_SSH_GIT 1
object-format sha1
head <40 lowercase hex digits>
ref refs/paperclip/ssh-sync/transfer/<UUID>
shallow-count <decimal N>
bundle-bytes <decimal M>
bundle-sha256 <64 lowercase hex digits>
<N sorted, unique shallow OID lines>
<M bundle bytes, then EOF>
```

Version 1 supports SHA-1 only. SHA-256 and mismatched object formats fail before
target mutation; they are a later explicit compatibility extension. All complete
sources send `shallow-count 0`; absent metadata is never interpreted as complete.
The header order is fixed. Reject unknown versions/fields, CR/NUL, duplicate OIDs,
invalid UUID/ref, negatives, overflow, leading signs, truncation, and trailing bytes.
Use the exact generated ref, never a caller-supplied arbitrary refspec.
The bundle must advertise exactly that ref and OID, with no prerequisites, filters,
or unknown capabilities. Do not accept an incremental bundle in version 1.

Limits: each header line at most 256 bytes, at most 8,192 shallow entries, at most
1 MiB total header, and at most 2 GiB bundle bytes. Reject larger sources explicitly;
never retry with metadata removed. Apply limits while reading, before disk growth,
and to generated output too. Retain the existing 60-second Git subprocess ceiling;
set a 120-second deadline for each envelope operation, including transfer and
validation, with cancellation killing and awaiting its child process group.
These are proposed limits requiring fixture evidence, not measured capacity claims.

Keep the existing SSH binary stream and progress reporting. Resolve metadata using
Git (`rev-parse --git-common-dir`, `rev-parse --git-path shallow`, and object format),
then canonicalize paths. A `.git` file is valid. Do not infer `.git/shallow` from a
worktree path. Stage under a generated private directory, mode 0700, with fixed
filenames. No archive extraction, received paths, repository config, hooks,
alternates, credentials, or shell text enter the target.

The controller sends the matching shell script on every operation; the remote has
no independently installed envelope daemon. Preflight Git, POSIX shell, bounded
byte reads, and SHA-256 checksum support (`sha256sum` or `shasum -a 256`). Do not
install remote tools. If a capability is missing, fail before mutation with a
specific unsupported-transport error. An old controller keeps its old behavior;
a new receiver rejects a bare legacy bundle. Mixed active controllers must be
drained at rollout. There is no automatic legacy fallback for shallow history.

## Capture one source snapshot

1. Allocate the UUID and private staging directory. Arm `finally`/shell traps before
   creating any ref or lock. Initialize cleanup variables before installing traps.
2. Acquire the common-directory transfer lock described below. Pin the requested
   commit with a create-if-absent UUID ref. Resolve HEAD once on export; never reuse
   the fixed export ref. A later branch move cannot change the pinned snapshot.
3. Read the shallow file as bytes. Traverse from the pinned commit with those
   declarations and select only reachable shallow commits. A source common-dir
   may contain unrelated shallow entries; do not copy those into the envelope.
4. Create the non-incremental bundle from the unique ref. Validate that every sent
   shallow OID is a commit reachable from the advertised snapshot. Check the raw
   object graph: all trees/blobs and every parent outside a declared cut must
   exist. Disable replace refs and lazy fetching. Reject partial/promisor clones,
   grafts, unsupported object formats, corruption, and missing undeclared parents.
   Gitlink entries keep normal submodule semantics; do not require submodule objects.
5. Re-read source shallow bytes and object format before closing the envelope.
   Any change aborts capture. This is detection for other Git writers, not a claim
   that the adapter lock stops arbitrary external commands. Pinning protects the
   snapshot from ordinary GC; concurrent manual prune is unsupported.
6. Record lengths/checksum, stream the envelope, and remove only this operation's
   source ref with an expected-OID delete. Release the source lock after capture,
   before waiting for a target lock. Never hold source and target locks together.

## Validate and combine with an existing target

Definitions: `B0` is the target's original shallow set; `Bs` is the validated source
set reachable from the transferred commit; `R0` contains all original target refs,
HEADs of all linked worktrees, and reflog roots. An empty target has `B0=R0=empty`.
An invalid existing target fails validation and stays available for diagnosis.

1. Receive and validate framing/checksum into private staging before opening the
   target for writes. Initialize a separate bare quarantine repository, install
   `Bs` there, then verify and fetch the bundle into its unique ref. Confirm exact
   HEAD/tree and the raw graph rules above. A valid checksum is integrity evidence,
   not independent proof that a source declaration is honest.
2. Under the target common-dir lock, snapshot `B0`, `R0`, ref OIDs, and the target
   worktree identity. Build a disposable candidate repository with the received
   objects plus read-only access to target objects, original roots, and `B0`.
   Alternates are permitted only in this internally constructed candidate; never
   publish that alternates file or trust alternates supplied by the stream.
   Prevent concurrent GC while candidate objects are in use.
3. Start `B = B0 union Bs`. Keep every `B0` entry; this change never unshallows or
   repairs old history. Process added entries in ascending OID order. Remove an
   added entry `b` if traversal from all its raw parents is complete under
   `B minus {b}`. Repeat until no entry can be removed. Traverse raw commit headers
   with memoized object lookups, not `git log` output that already hides parents.
   A cut covers commit parents only; it cannot excuse a missing tree/blob.
4. Reject any remaining added entry which is unreachable from the imported head,
   has no raw parents, or is reachable under `B0` from any `R0` root. Compare the
   original visible object/commit sets with candidate traversal of every `R0` root:
   no original object or parent edge may disappear. This independent comparison
   catches a syntactically valid shallow file that hides target history.
5. Validate all candidate roots with the final `B`, including the imported head,
   using graph checks and `fsck --full`. Every new cut must be source-declared and
   necessary: removing it must expose an unavailable parent path. An undeclared
   missing parent, missing non-parent object, or redundant new cut is rejection.

Consequences: a complete target with the source's full ancestry stays complete.
An existing shallow target keeps its unrelated refs and old cuts. A complete target
receiving unrelated incomplete history can become shallow only for that new
history; none of its previous history may be truncated. Multiple merge cuts and
different depths follow the same algorithm. Complete source into a shallow target
preserves `B0`; automatic deepening is outside scope.

## Locking, publication, and failure states

Use a per-common-dir lock, not a per-worktree or per-ref lock. On each host the
canonical common-dir contains `.paperclip-ssh-sync.lock/`, created atomically with
`mkdir`. Record operation UUID and process diagnostics in it. Acquisition has a
30-second deadline and cancellable bounded contention waits for this active
operation only. There is no background polling or age/PID-based lock stealing.
All new import/export capture and publication paths use this same lock key.
Different repositories remain independent.

At target publication, also exclusively create Git's resolved `shallow.lock`.
Abort if another Git writer owns it. Recheck original shallow bytes and root refs
before publishing; conditional ref updates detect changed expected refs. Use the
existing directory merge lock for worktree integration. Establish one order:
worktree directory merge lock, then Git common-dir transfer lock, then shallow
lock. Do not reacquire the directory lock from inside it. The baseline restore
imports its private ref first and releases the Git lock, then follows that order
inside the existing merge callback. Never acquire target locks during network I/O.

Publication is ordered, not a claimed cross-file atomic transaction:

| Step | Durable effect | Failure handling |
| --- | --- | --- |
| Validate in quarantine | No target changes | Delete operation staging/ref; original target unchanged. |
| Install verified pack and index with a unique `.keep` | Additive immutable objects only | Leave harmless unreachable objects; never delete pre-existing packs. |
| Atomically rename `shallow.lock` to the resolved shallow path when `B` changes | `B0` plus necessary new cuts | Every old root still has the same history. Write a private operation receipt first with old/new shallow hashes. |
| Create the UUID imported ref with expected-absent semantics | New snapshot becomes reachable | On ordinary failure, delete only an owned ref with expected OID; retain added shallow records and objects. Do not restore stale shallow bytes over another writer. |
| Existing checkout/reset or baseline merge integrates the snapshot | Existing prepare/restore semantics | Always release ref/locks in `finally`/trap, including checkout/reset/clean and later file-transfer failures. Report failure; do not claim whole-worktree rollback. |
| Integration completes | Remove temporary ref and this operation's `.keep` | Preserve final branch/merge refs; cleanup never uses namespace-wide deletion. |

The receipt is local transfer evidence, not a second task status machine. Its
phases and hashes distinguish validation, metadata publication, and integration.
If killed after metadata publication, old refs remain readable and only extra
objects/cuts can remain. A later admission encountering an unfinished receipt or
lock fails explicitly and preserves it for operator inspection. SIGKILL cannot run
shell traps; an operator must drain all relevant writers before moving a stale
lock. Do not infer staleness from age or an absent PID. This limitation and the new
limits must be accepted in the implementation decision.

Worktree writes retain current force-checkout/reset or conflict-aware baseline
merge behavior. A checkout failure can leave partial tracked-file changes; this
proposal does not promise an atomic filesystem rollback. Retain the baseline and
staging evidence on integration failure for the existing repair path. Never run
extra reset/clean commands to hide failure or retry after host-file writes start.
Unrelated refs, old shallow entries, and their object closure must remain valid
in every failure test. If that cannot be proven, stop before publication.

Locks serialize participating adapters only. Native shallow writers respect
`shallow.lock`; arbitrary external branch/worktree writes and manual GC must be
drained during managed integration. A CAS conflict aborts instead of overwriting
another writer. This is a filesystem correctness rule, not authorization inferred
from repository sharing or a change to company/task access.

## Alternatives

| Option | Benefit | Reason not selected for this patch |
| --- | --- | --- |
| Versioned bundle envelope and isolated publication | Keeps one-way SSH streams and current prepare/restore seam; works offline | Selected; requires graph validation, bounded staging, and explicit lock failure handling. |
| Native shallow fetch through SSH upload-pack | Lets Git negotiate shallow history | Requires a bidirectional transport or separately addressable staging repository in both directions. It changes the current stream/session contract. Reconsider if envelope publication is not demonstrably safe. |
| Force unshallow/full clone | Simplifies complete-history transfer | Needs origin credentials/network and potentially large history. Invalid for offline sources; never an implicit fallback. |
| Add `--update-shallow` or blindly copy source shallow | Very small edit | The flag does not restore absent metadata; blind copying can hide complete target history or discard old cuts. Rejected. |

## Isolated acceptance design

These are proposed case names, not tests already added or executed. Add them to
the existing real SSH fixture suite. Use synthetic repositories under fixture-owned
roots, `file://` clones with `--depth` (not ignored local-clone depth), and explicit
merge histories. No real task workspace is a test input. Always record local and
remote Git versions and whether SSH cases actually ran. The current fixture can
return early when SSH is unavailable; exit zero without executed fixture evidence
is not acceptance.

Every success case compares transferred HEAD/tree, file contents, exact shallow
sets, unchanged unrelated refs, visible history for old roots, and `fsck --full`.
Check raw parent availability separately. For failure cases compare the saved old
root graph, ref OIDs, and `B0`; allow only documented additive objects/cuts after
publication. Verify operation refs, ephemeral transport files, `.keep`, and locks are cleaned on
catchable failures without deleting another operation's resources. Integration
failure retains only the named baseline/staging repair evidence, not transport locks.

| Proposed fixture case | Setup and observable assertion | Old implementation witness |
| --- | --- | --- |
| `round-trips complete SSH history without adding shallow roots` | Complete source to empty target; remote commit plus dirty/untracked edits returns; shallow absent at both ends. | Compatibility control; current test is the starting point. |
| `round-trips depth-one SSH history into an empty target` | Three commits, clone depth 1; prepare exact source cut, commit remotely, restore exact new HEAD/tree and expected cut. | Prepare currently fails missing-parent traversal. |
| `restores shallow SSH history to an empty local repository` | Independently create shallow remote source and initialized empty local target; capture a baseline and call public restore with `restoreGitHistory: true`. | Export fetch currently fails missing-parent traversal. |
| `preserves existing shallow roots across two SSH syncs` | Target has another shallow branch; import a different depth and repeat after a new source commit; retain all old refs/cuts, no unnecessary added cuts. | Current fetch fails where its missing path has no target cut. |
| `keeps complete target ancestry when source is shallow` | Target has full source ancestry and another branch; no new cut, old ancestry set equal before/after. Also add unrelated shallow source: only that history gains cuts. | First setup controls against blind-copy regression; second fails current fetch. |
| `preserves merge and unrelated SSH history boundaries` | Two shallow merge arms and unrelated target root; verify each required cut and old root closure; reject extraneous/ redundant cuts. | Current empty-target import fails. |
| `isolates exports from the same SSH repository` | Barrier after each source pin, move HEAD between captures, interleave two exports; each receiver gets its pinned OID. | Fixed export ref can point both bundles at the later OID. |
| `serializes shallow publication across linked worktrees` | Two target worktrees share common-dir; overlap restore and import, prove serialized common-dir critical sections and both imported snapshots/history. | Current per-ref uniqueness supplies no shallow merge transaction. |
| `cleans owned SSH refs after injected failures` | Inject before bundle creation and at transfer/fetch/checkout/reset/clean/merge; run both directions; verify old root closure and foreign sentinel ref survives. | Current import checkout failure leaves remote ref; early export failure can leave fixed ref. |
| `rejects unsafe SSH envelopes before publication` | Truncated bytes, wrong hash/OID/ref/version, non-commit cut, missing tree, removed necessary cut, extra cut, prerequisite, path text, oversized header/count/body, format mismatch and promisor source. | New contract tests; do not pretend current code implements a parser. |
| `preserves Git validity after interrupted SSH publication` | Kill at pack install, shallow rename, ref publish and integration; old roots remain valid; unfinished receipt/lock blocks reuse; drained fixture cleanup only. | New failure contract; catches false claims of cross-file atomicity. |
| `uses resolved Git paths and bounded SSH lock waits` | `.git` file, linked worktrees, held common-dir/shallow locks; contender expires at 30s without writes; unrelated repo progresses; cancellation terminates child group. | New locking/path contract. |

To demonstrate regression sensitivity after implementation approval, first add the
depth-one prepare case at the old base and run it to the expected missing-parent
failure. Also run the cleanup and export-race witness with deterministic barriers.
Then apply the implementation and rerun the same cases. Never mark a skip as red
or green, or remove assertions to manufacture a passing comparison.

Proposed commands from the repository root (not executed for this docs PR):

```sh
pnpm exec vitest run packages/adapter-utils/src/ssh-fixture.test.ts
pnpm exec vitest run packages/adapter-utils/src/ssh-command-managed.test.ts
pnpm --filter @paperclipai/adapter-utils typecheck
pnpm -r typecheck
pnpm test:run
pnpm build
```

Run each foreground command with an overall timeout at most 600 seconds; move
longer full-suite checks to normal CI. Preserve the initial failure evidence,
fixed base/head SHAs, executed/skipped counts, exit codes, elapsed time, lock/ref
inventories, and object-graph comparisons. Do not run browser suites for this change.
Measure envelope bytes and capture/validation time for complete and shallow cases;
there is no idle scan or new recurring worker. Limits exceeded fail explicitly.

## Implementation order and release gate

After independent review of an exact proposal SHA, the Board must decide whether
to implement this option, accept its limits/crash handling, or request a different
transport. Approval of this document is not approval to implement or merge runtime
code. A later authorized code PR must implement both directions, the shared
validation/publication rules, UUID cleanup, and the fixture evidence together.
Do not deploy an import-only or blind-copy intermediate fix.

Before rollout, ops must verify the approved code SHA against the build and actual
installed server/adapter-utils, drain old controllers/writers, and qualify on
throwaway SSH targets. No migration or automatic edit of failed business
workspaces is included. Public prepare/restore types and task policy stay stable.

An independent operator/acceptance reviewer must then:

1. Save the original issue, stage ID, participant, return assignee, responsible
   user, decisions, review count, holds, and exact pending recovery action.
2. Use only the separately authorized existing recovery path. Resume the original
   reviewer on the original task; do not substitute the author, reset review
   counters, clear holds, or replay business writes to make a smoke test pass.
3. Show the real reviewer run crossing Git import and reaching provider startup,
   with HEAD/tree and required shallow cuts verified. Import progress at 100% or
   a fixture success is insufficient.
4. Re-read the same policy/stage identities, decisions and count. Explain any
   legitimate new decision separately; absence of a reset is required evidence.
5. Have a person or cross-type reviewer who did not implement the change accept
   the deployed result. No such recovery or acceptance is claimed in this PR.

Rollback is an ops action on an approved deployment SHA after draining writers.
Keep collected evidence, target objects, and shallow files. Never delete shallow,
rewrite business refs/history, edit installed JS, resolve recovery actions, clear
holds, change credentials, or replay completed operations as a rollback shortcut.
Older controllers still cannot transfer shallow snapshots safely; restoring the
old binary means preserving that known limitation, not claiming service recovery.

## Proposal completion criteria

- One docs-only Draft PR created before the proposal file, linked to Issue #17.
- One selected option, exact framing/limits and unsupported-peer behavior.
- Explicit algorithms for empty, shallow, complete, merge, and unrelated targets.
- Per-common-dir serialization, unique refs, catchable-failure cleanup, and honest
  crash/partial-worktree limits.
- Named real SSH cases, old-code witnesses, assertions, commands, and skip policy.
- Exact source/deployment identification, separated from later implementation proof.
- Author self-check followed by the configured independent review at an exact SHA.
- Only after that review: a concrete Board implementation decision. The docs PR
  remains Draft; no merge, implementation task, rollout, or recovery is inferred.

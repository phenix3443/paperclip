# Detached repository retention

A repository removed from a task's repository set can contain private commits,
stashes, and local files. It must remain recoverable outside the delivery worktree.

The fix in #357 uses the instance's `detached-repositories/<companyId>/<executionWorkspaceId>/`
directory. Each retained checkout has a durable custody receipt. All receipt
states, including `retained`, `rolled_back`, and `aborted`, block workspace removal.
Cleanup, Git expiration, task-directory retention, and compaction must refuse
under their existing locks before removing any workspace content.

Legacy `.paperclip-runtime/detached-repositories` directories remain untouched.
Migration and safe removal require separate designs and authorization. A matching
status digest or accepted custody receipt does not authorize deletion.

Preparation holds the existing source lock, then the workspace lifecycle lock,
then the linked repository base lock. Reopen uses its existing transaction.
Missing identity, cross-device moves, unsafe paths, foreign worktrees or locks,
and collisions leave the source in place with a warning; there is no copy/delete
fallback. One refused entry does not stop the other repository preparations.

Each receipt records source/destination paths, checkout device/inode, private Git
identity and status digests, timestamps, and append-only state history. Linked
worktrees are repaired and locked with a receipt-specific reason. A pending receipt
is reconciled by inode during the next normal preparation. Ops-only states are
never automatically changed. State changes do not truncate history.

An external process can write through an open descriptor or cwd after rename.
Those writes follow the checkout. Later path writes can recreate the old entry;
they remain in place because retention history permanently blocks removal. A
matching digest is diagnostic evidence only. No scan or repeated guard proves
that unknown writers have stopped.

Failed workspace persistence does not bypass retention: cleanup of a reconstructed
workspace re-reads its native identity and history under the source and lifecycle
locks before teardown or removal. Without a verified durable identity, the new
directory remains in place and preparation reports the original persistence error.

Retention refusal creates no removal retry deadline. The existing terminal worker
reconsiders a held workspace when a native workspace or issue change triggers it;
retained history alone does not keep the worker waking. Locked removal guards
remain authoritative even if history appears after that scheduling assessment.

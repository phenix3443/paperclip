# Detached repository retention

A repository removed from a task's repository set can contain private commits,
stashes, and local files. It must remain recoverable outside the delivery worktree.

The pending fix in #357 uses the instance's `detached-repositories/<companyId>/<executionWorkspaceId>/`
directory. Each retained checkout has a durable custody receipt. All receipt
states, including `retained`, `rolled_back`, and `aborted`, block workspace removal.
Cleanup, Git expiration, task-directory retention, and compaction must refuse
under their existing locks before removing any workspace content.

Legacy `.paperclip-runtime/detached-repositories` directories remain untouched.
Migration and safe removal require separate designs and authorization. A matching
status digest or accepted custody receipt does not authorize deletion.

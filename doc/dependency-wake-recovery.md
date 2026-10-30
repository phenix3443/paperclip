# Dependency wakes and deliberate stops

A task can remain blocked after all recorded dependencies finish. Its assignee
may be waiting for an external action. Blocking its own task does not request
another dependency wake. The periodic recovery sweep preserves this decision,
including native status decisions attributed to the assignee's bound run.

Title, monitor, and other unrelated edits do not change this wait. A later
assignment, status, or blocker-set update permits reconciliation again. A blocker
that completes or finishes workspace export after the wait also permits a wake.
The export must name the blocker issue. An export from the waiting task or an
unattributed operation in the same shared workspace does not remove its wait.
Normal readiness, duplicate-wake, interaction, pause, and execution gates still
apply. A board transition into blocked keeps the existing recovery behavior.

Native status dispatch limits ordinary intents, dependency intents, and
unfinished dependency result receipts separately. Each group uses the requested
batch limit, so held or conflicting dependency work cannot consume the ordinary
intent allowance. Retired dependency inputs leave the candidate set. Historical
skipped inputs remain terminal unless a matching legacy receipt permits verified
adoption; adoption still checks durable provenance and identity under the input
lock. This batch separation does not provide fairness within each group or
automatically release paused work.

Cancelling a run or pausing its agent suppresses immediate stranded-work recovery.
A queued user message remains a separate continuation request. The release path
still preserves independently authorized deferred input; stopping the old run
does not discard that input or grant permission to replay its old tools.

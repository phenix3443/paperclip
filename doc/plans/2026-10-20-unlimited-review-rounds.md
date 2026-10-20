# Unlimited review rounds

Add `executionPolicy.maxReviewRounds = 0` as an explicit unlimited policy. Omitted or null values retain the default of three rounds; positive values retain bounded escalation. Preserve review gates, decision history and the diagnostic round counter.

Verify normalization, rework and resubmission beyond the third and fiftieth rounds, eventual approval, and unchanged default/positive-limit behavior. Update the shared contract and execution-policy documentation. No database migration is needed.

This maintenance branch starts at the 2026.1012.0 source release so a managed git-ref installation can adopt the policy change without an unrelated runtime upgrade.

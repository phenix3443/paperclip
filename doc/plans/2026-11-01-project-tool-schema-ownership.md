# Project tool schema ownership

Implement the contract in [#350](https://github.com/phenix3443/paperclip/issues/350)
from base `64ea2bdfb34b897dae3b7288ad99452d5543055d`
(tree `9bef6328a0f21a11acc374dfa50cd4a3b2c699d2`). This base is the merged
[#345](https://github.com/phenix3443/paperclip/pull/345). Its changes from
`dadf335622abf6c43756a3e186751c7a1a5bef22` affect only blocker classification.
None of the schema conversion changes from the earlier candidate is present.

The shared package owns conversion of its project creation, GitHub assessment,
and avatar schemas. Project discovery and execution use the same required
idempotency schema. Each tool definition can fail independently during listing;
the transport reports degraded discovery without exposing exception contents.
Execution validation and authorization retain their current owners.

Verification uses the existing project tool, route, chat, title and avatar test
seams, plus an isolated module-resolution fixture with Zod 4.4.3 and 4.6.7.
The fixture must fail when the older converter receives the newer record schema
and pass when each schema is converted by its defining package. It also checks
input rejection and package exports. No live installation or credentials are used.
Full typecheck and build run in CI. Source evidence does not certify deployment.

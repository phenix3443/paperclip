# Queued comment comparison evidence

Date: 2026-10-29. Synthetic data only. Production code was not modified.

## Fixture and preparation

Fixture SHA-256: `df6d858ca7a05f9fd612e38678bb66eafb1ca07a9339bf6fcdf24d32997810ea`. The same bytes ran on all three checkouts.

All three installs used `timeout 300 pnpm install --frozen-lockfile --ignore-scripts` (head/upstream used a 240-second limit). Install succeeded. The first test invocation failed before tests loaded because `@paperclipai/plugin-sdk` had no built entry. That is a preparation failure, not the comment-loss symptom.

`timeout 180 pnpm --filter @paperclipai/plugin-sdk ensure-build-deps` then succeeded on base. `git diff --stat` for both base→head and base→upstream showed no differences in `packages/shared` or `packages/plugins/sdk`. Their generated `dist` trees were copied to the other disposable checkouts. No production source was copied or changed.

Final command in each checkout:

```sh
timeout 240 pnpm exec vitest run --project @paperclipai/server server/src/__tests__/queued-inline.test.ts
```

| Checkout | SHA | Verdict | Duration |
| --- | --- | --- | --- |
| base | `51c3f8924cb0bd5fe7cbda15ad9b8f06a6a11055` | exit 1; 2 failed / 2 executed | Duration  100.33s (transform 60%, import 28%, tests 12%) |
| head | `b88510990d7c59be1b2b1371d8c4774f36a7fc87` | exit 1; 2 failed / 2 executed | Duration  100.81s (transform 61%, import 27%, tests 12%) |
| upstream | `49fe8b87a49aa5a8985a08dd3d5ce57bdd24756c` | exit 1; 2 failed / 2 executed | Duration  100.70s (transform 61%, import 26%, tests 13%, setup 1%) |

## Observed transition

Every case accepted the second comment into the first queued run; the second source receipt was linked to that run. Before claim the run contained both IDs, but the root envelope contained only the first ID. After drain the process started once and the run succeeded, while canonical `wakeCommentIds` contained only the first ID. The final `arrayContaining([first, second])` assertion failed in both execution-lock variants on every checkout.

This isolates the same-submission failure without the cross-generation transition that caused the separate original #18060 failure. Base and current upstream reproduce it. The result does not prove that all #18060 behavior is correct or complete.

## Machine-readable diagnostic lines

### base

```text
INLINE_REPRO {"locked":false,"first":"99a5ec5b-3709-464f-8cdc-4ec409671144","second":"2dc8be67-a481-428a-a2e4-9c3e3919be86","beforeIds":["99a5ec5b-3709-464f-8cdc-4ec409671144","2dc8be67-a481-428a-a2e4-9c3e3919be86"],"rootIds":{"taskId":"d68ba981-d1a1-4748-95c7-fa762a47fe84","issueId":"d68ba981-d1a1-4748-95c7-fa762a47fe84","taskKey":"d68ba981-d1a1-4748-95c7-fa762a47fe84","commentId":"99a5ec5b-3709-464f-8cdc-4ec409671144","wakeReason":"issue_commented","wakeSource":"automation","wakeCommentId":"99a5ec5b-3709-464f-8cdc-4ec409671144","wakeCommentIds":["99a5ec5b-3709-464f-8cdc-4ec409671144"]},"afterIds":["99a5ec5b-3709-464f-8cdc-4ec409671144"],"status":"succeeded","providerRunIds":"c6beb43a-d6f9-4ada-b39f-3d1524e4a660\n"}
INLINE_REPRO {"locked":true,"first":"4d0e3851-f54c-4a0d-99ce-26c0c7a5db83","second":"419ecf88-b5a1-427f-ae64-1e335faaac73","beforeIds":["4d0e3851-f54c-4a0d-99ce-26c0c7a5db83","419ecf88-b5a1-427f-ae64-1e335faaac73"],"rootIds":{"taskId":"e2d86657-b980-4947-822f-9548d9eda3d9","issueId":"e2d86657-b980-4947-822f-9548d9eda3d9","taskKey":"e2d86657-b980-4947-822f-9548d9eda3d9","commentId":"4d0e3851-f54c-4a0d-99ce-26c0c7a5db83","wakeReason":"issue_commented","wakeSource":"automation","wakeCommentId":"4d0e3851-f54c-4a0d-99ce-26c0c7a5db83","wakeCommentIds":["4d0e3851-f54c-4a0d-99ce-26c0c7a5db83"]},"afterIds":["4d0e3851-f54c-4a0d-99ce-26c0c7a5db83"],"status":"succeeded","providerRunIds":"ebb25601-59cb-4f6b-bc24-704938bba4e5\n"}
```

### head

```text
INLINE_REPRO {"locked":false,"first":"b1ee2d8b-bc27-426b-b348-e9e68930bc13","second":"a6cd47d6-4c6c-485f-a603-90dc181041d3","beforeIds":["b1ee2d8b-bc27-426b-b348-e9e68930bc13","a6cd47d6-4c6c-485f-a603-90dc181041d3"],"rootIds":{"taskId":"2f5fda73-5e60-45f1-8ab9-2e19dce21a97","issueId":"2f5fda73-5e60-45f1-8ab9-2e19dce21a97","taskKey":"2f5fda73-5e60-45f1-8ab9-2e19dce21a97","commentId":"b1ee2d8b-bc27-426b-b348-e9e68930bc13","wakeReason":"issue_commented","wakeSource":"automation","wakeCommentId":"b1ee2d8b-bc27-426b-b348-e9e68930bc13","wakeCommentIds":["b1ee2d8b-bc27-426b-b348-e9e68930bc13"]},"afterIds":["b1ee2d8b-bc27-426b-b348-e9e68930bc13"],"status":"succeeded","providerRunIds":"61b906c7-4322-4990-8481-ad6e5a8950ca\n"}
INLINE_REPRO {"locked":true,"first":"f5a2ef7f-17a1-4eeb-89ac-66d37000c95c","second":"23427cfa-bfe4-4339-a794-86efced5b582","beforeIds":["f5a2ef7f-17a1-4eeb-89ac-66d37000c95c","23427cfa-bfe4-4339-a794-86efced5b582"],"rootIds":{"taskId":"269f7956-5d03-480c-8458-9bc5d1abb676","issueId":"269f7956-5d03-480c-8458-9bc5d1abb676","taskKey":"269f7956-5d03-480c-8458-9bc5d1abb676","commentId":"f5a2ef7f-17a1-4eeb-89ac-66d37000c95c","wakeReason":"issue_commented","wakeSource":"automation","wakeCommentId":"f5a2ef7f-17a1-4eeb-89ac-66d37000c95c","wakeCommentIds":["f5a2ef7f-17a1-4eeb-89ac-66d37000c95c"]},"afterIds":["f5a2ef7f-17a1-4eeb-89ac-66d37000c95c"],"status":"succeeded","providerRunIds":"2cf632b1-4178-47ed-a631-2245044dd2a1\n"}
```

### upstream

```text
INLINE_REPRO {"locked":false,"first":"4e2d53c2-8005-4cb6-8369-a4dec8f61667","second":"ed78300c-b638-4b35-9da3-5e227cdabbc4","beforeIds":["4e2d53c2-8005-4cb6-8369-a4dec8f61667","ed78300c-b638-4b35-9da3-5e227cdabbc4"],"rootIds":{"taskId":"d22491a9-f8ec-4778-8a0a-a6804839899e","issueId":"d22491a9-f8ec-4778-8a0a-a6804839899e","taskKey":"d22491a9-f8ec-4778-8a0a-a6804839899e","commentId":"4e2d53c2-8005-4cb6-8369-a4dec8f61667","wakeReason":"issue_commented","wakeSource":"automation","wakeCommentId":"4e2d53c2-8005-4cb6-8369-a4dec8f61667","wakeCommentIds":["4e2d53c2-8005-4cb6-8369-a4dec8f61667"]},"afterIds":["4e2d53c2-8005-4cb6-8369-a4dec8f61667"],"status":"succeeded","providerRunIds":"fe16db6e-f796-437b-8e52-418251e3d006\n"}
INLINE_REPRO {"locked":true,"first":"a529b20e-8558-47c3-aaf8-609834c487e3","second":"c0d931ed-9588-4622-9a80-2ab5d6dc88b5","beforeIds":["a529b20e-8558-47c3-aaf8-609834c487e3","c0d931ed-9588-4622-9a80-2ab5d6dc88b5"],"rootIds":{"taskId":"79bcc847-becf-427b-974b-df14a8ff91fe","issueId":"79bcc847-becf-427b-974b-df14a8ff91fe","taskKey":"79bcc847-becf-427b-974b-df14a8ff91fe","commentId":"a529b20e-8558-47c3-aaf8-609834c487e3","wakeReason":"issue_commented","wakeSource":"automation","wakeCommentId":"a529b20e-8558-47c3-aaf8-609834c487e3","wakeCommentIds":["a529b20e-8558-47c3-aaf8-609834c487e3"]},"afterIds":["a529b20e-8558-47c3-aaf8-609834c487e3"],"status":"succeeded","providerRunIds":"9b2110de-eeca-4596-937b-e1813b49c3f5\n"}
```

## Preserved failure excerpt

```text
 FAIL  |@paperclipai/server| src/__tests__/queued-inline.test.ts > review submission generation > preserves same-submission merged comments (locked: false)
AssertionError: expected [ Array(1) ] to deeply equal ArrayContaining{…}

- Expected
+ Received

- ArrayContaining [
+ [
    "99a5ec5b-3709-464f-8cdc-4ec409671144",
-   "2dc8be67-a481-428a-a2e4-9c3e3919be86",
  ]

 ❯ src/__tests__/queued-inline.test.ts:77:56
     75|         providerRunIds: await readFile(marker, "utf8") }));
     76|       expect(finished.status).toBe("succeeded");
     77|       expect(finished.contextSnapshot?.wakeCommentIds).toEqual(expect.…
       |                                                        ^
     78|     } finally { await service.drainActiveRunExecutions(); await rm(mar…
     79|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  |@paperclipai/server| src/__tests__/queued-inline.test.ts > review submission generation > preserves same-submission merged comments (locked: true)
AssertionError: expected [ Array(1) ] to deeply equal ArrayContaining{…}
```

The original exploration also failed at `finished.contextSnapshot.wakeCommentIds` after adding its second fresh same-generation comment. Its log reports `ArrayContaining` with two IDs, and an actual array with only the first (`green-comment.log`, test line 114). The original `red-comment-id.log` failed earlier at fresh run identity and addresses the separate cross-generation problem. These are distinct failures.

## Limits

The process fixture records only the run ID. It does not consume prompt text. No provider-input body assertion passed in this investigation. The plan requires a real text-consuming adapter subprocess regression before implementation acceptance. No fix was attempted. Repo-wide typecheck/tests/build were not run for this documentation and deliberately failing fixture delivery. The fixture is under `doc/plans/fixtures`, outside the normal test include paths.

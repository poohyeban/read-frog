# Request queue contract

`rate` remains tokens/second and `capacity` remains burst capacity. Optional internal `maxConcurrent` counts executing attempts independently. It is not persisted into user settings; absent means unlimited, matching the previous default. A positive integer is required. Waiting for tokens, a scheduled start or retry backoff does not occupy a slot.

Every attempt has its own slot token and AbortController. Cleanup removes its timeout and abort listener, releases that token exactly once and wakes scheduling. Retries are inserted into the waiting heap but cannot dispatch before the previous attempt finishes cleanup. A cancelled task's late transport result cannot delete a replacement task with the same hash or free its slot.

Timeout abort is cooperative. A retry is allowed only when the previous transport has settled; an unconfirmed abort gets a 100ms bounded settlement window, then fails that logical request without retrying it. This keeps a broken transport from locking the queue indefinitely. No JavaScript queue can physically terminate a transport that ignores AbortSignal: the limit bounds live logical attempts; such a broken transport may outlive a failed attempt, but it is never overlapped by automatic retries of that attempt. Real fetch cancellation is tested against a local HTTP server and confirmed by response closure.

429 handling retains existing Retry-After and retry budgets. Accrual during the cooldown is capped at one probe token instead of restoring a full burst. Existing shared-task scope cancellation and fail-fast behavior remain.

Verification: 9 request test files / 169 tests passed. New regressions first failed on the baseline for capped concurrency, late-result slot ownership and noncooperative timeout retries. No finite production default is selected before the load experiment; leaving it unset is a supported outcome. Revert this unit independently, retaining request identity correctness fixes and existing user rate settings.

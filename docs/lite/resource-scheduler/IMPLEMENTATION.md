# Resource scheduling and subtitle convergence

Approved scope: remove cumulative spending/usage admission systems, keep bounded per-request work, unify physical provider scheduling, expose sparse advanced configuration, and fix Quality transcript projection and historical cache restoration. Development, validation and commits remain local. No paid API benchmarks, GitHub Actions, push, PR or release.

## Execution ownership

`RequestQueue` owns logical tasks, deduplication, subscriber cancellation and delayed finite retries. `BatchQueue` owns bounded aggregation and format-only recovery. Neither owns a physical token bucket or concurrency pool. `ResourceScheduler` is the background authority for actual remote concurrency, rate, burst, cooldown and central priority/aging decisions. It acquires every applicable credential/group constraint together, or acquires none. Indexed lane heads and deadline heaps avoid scanning all tasks on dispatch; configuration changes may walk bounded queued and active work.

The normal text and consumed-stream gateway, and the audio adapters, acquire physical permission only after local preparation/cache lookup. SDK retries are zero. The transport checks the execution permit and lease immediately before fetch. Stream permission remains occupied through iterator completion/cancellation. Local TTS playback, subtitle rendering, source parsing and cache lookup do not acquire remote permission. AST architecture tests constrain SDK imports, model factories and remote transport entrances; runtime tests exercise real SDK serialization against Mock transport.

A cancelled uncooperative client operation retains its physical occupancy until its promise/stream actually terminates. Cancellation rejects subscribers promptly and keeps a dedup tombstone. Remote servers may ignore Abort or continue work after the extension's worker crashes. The extension cannot guarantee remote server concurrency or exactly-once execution across that boundary. A new worker invalidates prior playback leases and does not replay them. Shared cooldown persists within the browser session.

## Identity and policy

Identity uses the normalized effective endpoint/authentication, organization/project and adapter-verified stable account identity when available. Custom paths and tenant information remain significant. Unverified rotating credentials are conservatively isolated. Display names and model labels do not identify physical resources. HMAC and credential material stay private in a bounded installation vault; opaque IDs bind groups. The primary and recovery vault records are written together before publication. A valid recovery copy restores missing/corrupt primary state. Conflicting roots or missing roots with existing bindings fail closed instead of silently creating new identities.

One physical identity belongs to at most one manual group. Same-account provider aliases share one credential domain. Explicit alias limits combine conservatively; absent aliases do not overwrite deliberately raised limits with defaults. Manual group policy supplies inherited defaults plus a shared constraint. Credential changes produce a new identity outside the old group's membership. Configuration events update policy and identity snapshots; dispatch does not read storage or compute HMACs. Existing operations retain their original permissions, and group transitions include shadow occupancy. Edits do not grant fresh burst tokens.

## Attempts and failures

`maxAttempts` includes the initial actual Provider attempt, per original task member. One physical batch attempt charges each participating member once. Suitable batch format/count errors split immediately, with each member retaining its consumed attempts. Other failures do not split: authentication/permanent errors fail, 429 shares cooldown, and transient errors use finite backoff. SDK and business layers cannot mint extra attempt allowances. For an initial N-member batch with limit R, complete individual recovery is bounded by `1 + N*(R-1)` physical calls; with differing limits, `1 + sum(R_i-1)`. Five members with R=3 therefore permit at most 11 calls. If an original logical window is partitioned into B initial physical batches, the bound is B + sum(R_i-1), at most sum(R_i). Joining a duplicate shares the original attempt records.

## Configuration and live updates

The root config is schema v6; resource tuning lives separately in `local:performanceOverrides` as versioned Defaults + Sparse Overrides. Opening an editor or restoring an already-default section performs no write. Blur/Enter commits one validated field through a serialized background writer, preventing concurrent tab edits from replacing each other. Provider, group, batching, buffer and global controls start collapsed. Section reset removes overrides; full configuration reset also removes tuning and groups while retaining the identity vault and user caches.

Rate, burst, actual concurrency, queue capacity, request timeout, total attempts, retry delays, 429 cooldown and priority aging are editable within finite validated ranges. Limits and identity snapshots update on events, without storage reads or HMAC computation in request/playback hot paths. Running transports retain occupancy when concurrency is reduced. New attempts observe current policy; an existing member's allowance can shrink but cannot grow beyond its initial limit. A previously scheduled backoff is not replayed or dispatched twice when the policy changes.

The v5 migration preserves nondefault legacy queue settings, `workBudget.maxInFlight` and diagnostics before removing obsolete budget fields. Historical v5 default values do not become sticky overrides. IndexedDB v6 removes only the obsolete budget/attempt tables; v7 adds a bounded candidate-window index. Translation, segmentation, glossary and candidate data remain intact. The migration is exercised in real Chromium IndexedDB, as well as unit tests.

## Subtitle correctness and bounded work

Cache restoration, display selection and Provider admission are independent. Exact semantic cache keys ignore display names and unrelated provider settings. Legacy keys are read where their source/configuration can be proved equivalent; the implementation does not guess across changed credentials or source tracks. Candidate loading batches indexed queries and translation-cache validation; repeated playback inside the same loaded window avoids additional reads.

Quality transcript rows preserve each complete original/translation pair and take ownership of their source interval. Overlapping Fast rows cannot duplicate that content. Unchanged rows, identities, source spans and projections are reused; current-time updates do not rebuild the list. Virtual scrolling preserves a source-time/pixel anchor, with a finite cancellable positioning loop.

Quality segmentation manifests identify the exact source block, output variant, index and member count. Restore marks only complete, text-aligned, successful intervals as processed. Partial variants remain bounded and can finish later. Proven full historical Quality can suppress AI segmentation even when the independent segmentation cache has expired. Source-block hashes and subtitle identity indexes are created lazily.

Fast and Quality retain independent timelines and configurable continuous buffers. With a single physical slot, Fast establishes enough runway before slow Quality work begins. Already-running remote work cannot be preempted. Playback speed, dense cues and repeated seeks remain subject to independent per-request cue/text/media/output bounds and finite pending batches. A hidden tab suspends speculative Quality work. Failures do not create a second business-layer automatic retry loop.

Complete SRT export remains an explicit separate task: preflight estimate/confirmation, bounded chunks, local assembly, progress, cancellation, strict completeness, and recorded local-segmentation fallback. Playback stop does not revoke its lease. Translation failure never produces a misleading complete SRT.

## Validation

The isolated v2 comparison revision is `fddc448e72cca5aa3007fcf27ab15c378288c844`. All performance Providers are local mocks. See `ACCEPTANCE.md` and `evidence/` for executed checks, raw comparisons, commands, defaults rationale and environmental limitations. Native MV3 installation is blocked by the managed browser policy; browser Mock E2E must not be described as native extension acceptance.

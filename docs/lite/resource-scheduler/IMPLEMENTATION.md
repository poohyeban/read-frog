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

`maxAttempts` includes the initial actual Provider attempt, per original task member. One physical batch attempt charges each participating member once. Suitable batch format/count errors split immediately, with each member retaining its consumed attempts. Other failures do not split: authentication/permanent errors fail, 429 shares cooldown, and transient errors use finite backoff. SDK and business layers cannot mint extra attempt allowances. For an initial N-member batch with limit R, complete individual recovery is bounded by `1 + N*(R-1)` physical calls; with differing limits, `1 + sum(R_i-1)`. Five members with R=3 therefore permit at most 11 calls. Joining a duplicate shares the original attempt records.

## Remaining implementation stages

Finish the advanced Defaults + Sparse Overrides editor and serialized background patch handling; then repair Quality merged transcript rows and source-block restoration with strict semantic identities, and connect configurable continuous buffers. Preserve source/cache data, migrations and independent bounded SRT export. Final acceptance includes the full test/type/lint/format suites, browser Mock E2E, WXT production build, 100 seek/toggle/stop-start regressions, and Mock performance comparisons against the isolated v2 baseline `fddc448e72cca5aa3007fcf27ab15c378288c844`. Final evidence will distinguish virtual media time from measured browser CPU/heap and state any unavailable native-extension coverage.

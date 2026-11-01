# Context Engine V2 performance

## 7321d6f9 production hardening (current comparison)

Fixed baseline and fetched HEAD: `7321d6f9ada3a0335a876b2c076aebe4cdc4b0b5`. Prior 1af30d16 figures below are historical, not this control.

Chromium 154.0.8037.57, Linux x64, Node 24.19.0, same workspace/dependencies. Each version has **20 fresh-page cold samples per corpus (80 total)**, 50 distinct scopes where available, 100 warm reads and 100 resolver calls per page. Performance runs were sequential, without concurrent tests/builds. The same instrumentation counts JS-visible getComputedStyle/getAttribute/textContent/childNodes/cloneNode calls; native browser internal reads are not counted.

| Units | Cold P50 ms before → after | Cold P95 ms before → after | Cold sample variance ms² before → after | CPU median s before → after | Post-release JS heap MiB before → after |
| ----- | -------------------------- | -------------------------- | --------------------------------------- | --------------------------- | --------------------------------------- |
| 1     | 84.15 → 87.55              | 100.50 → 95.70             | 102.52 → 65.64                          | 0.11 → 0.12                 | 2.96 → 2.99                             |
| 100   | 62.70 → 74.95              | 69.80 → 84.10              | 42.01 → 61.69                           | 0.13 → 0.17                 | 2.51 → 2.53                             |
| 1000  | 96.45 → 106.15             | 124.80 → 131.30            | 272.57 → 128.81                         | 0.27 → 0.31                 | 2.58 → 2.61                             |
| 50000 | 2536.95 → 2541.20          | 2904.60 → 2951.60          | 37690.51 → 28609.74                     | 5.21 → 5.31                 | 2.73 → 2.75                             |

| Units | Warm P50/P95 ms before → after | Resolve P50/P95 ms before → after | Instrumented style calls median before → after |
| ----- | ------------------------------ | --------------------------------- | ---------------------------------------------- |
| 1     | 0.00/0.20 → 0.00/0.20          | 0.00/0.10 → 0.00/0.10             | 26.00 → 33.00                                  |
| 100   | 0.00/0.10 → 0.00/0.10          | 0.00/0.00 → 0.00/0.10             | 714.00 → 624.00                                |
| 1000  | 0.00/0.10 → 0.00/0.10          | 0.00/0.10 → 0.00/0.10             | 714.00 → 624.00                                |
| 50000 | 0.00/0.10 → 0.00/0.10          | 0.00/0.10 → 0.00/0.10             | 714.00 → 624.00                                |

Each attribute row has 1,000 mutations and demanded reads. CPU is for that complete row.

| Scenario  | Read P50/P95 ms before → after | CPU s before → after | Live body projections before → after | Actual snapshot rebuilds before → after | Style calls before → after |
| --------- | ------------------------------ | -------------------- | ------------------------------------ | --------------------------------------- | -------------------------- |
| class     | 0.30/0.60 → 0.20/0.50          | 0.47 → 0.41          | 1000 → 0                             | 1000 → 0                                | 13000 → 11000              |
| style     | 0.40/1.10 → 0.10/0.20          | 0.58 → 0.18          | 1000 → 0                             | 1000 → 0                                | 13000 → 11000              |
| text      | 0.30/0.90 → 0.40/1.20          | 0.48 → 0.57          | 1000 → 1000                          | 1000 → 1000                             | 13000 → 22000              |
| unrelated | 0.00/0.10 → 0.00/0.10          | 0.05 → 0.06          | 0 → 0                                | 0 → 0                                   | 0 → 0                      |
| move      | 0.00/0.10 → 0.10/0.20          | 0.05 → 0.14          | 0 → 0                                | 0 → 0                                   | 0 → 11000                  |
| recycle   | 0.30/0.70 → 0.40/1.00          | 0.46 → 0.54          | 1000 → 1000                          | 1000 → 1000                             | 13000 → 11000              |
| privacy   | 0.30/0.70 → 0.30/0.80          | 0.44 → 0.45          | 1000 → 1000                          | 1000 → 1000                             | 13000 → 10500              |

The normal article cold P95 improves, but the 100-unit feed cold P95/CPU and
true-change/move rows do not all improve. This was investigated before acceptance:
source changes now perform bounded eligibility/fingerprint validation before fresh
projection; moves validate current container/privacy rather than blindly reusing;
class changes use a detached semantic parse. Container signatures are shared weakly
and reused only after their actual fields compare equal. The intermediate and final
measurements are both archived; no safety checks were removed to meet a timing goal.
The remaining overhead is a **conditional performance acceptance item**, especially
on slow target machines; this is not an across-the-board speedup claim.

All rows have zero observed summary RPCs, translation RPCs and local model HTTP.
Both versions finish with zero scopes, snapshots, active extractions/preparations,
work entries and observers after release. Peak acquired scopes are 1 or 50. Counts
reflect a bounded live test, not an hours-long native-memory soak. Heap retains the
fixture document, especially the 50,000-element page; it is not total native memory.
Long Tasks/CPU include fixture construction, layout and mutation work; they do not
isolate parser execution. Cold mutation-batch latency includes fixture writes;
attribute `invalidations` samples measure explicit synchronization separately.

Raw per-sample read/resolve/invalidation times, DOM/style counts, hit rates, Long
Tasks, CPU/heap and resource balances are in
[evidence/hardening/performance-summary.json](evidence/hardening/performance-summary.json)
and the baseline/final raw files beside it. P95 uses nearest rank; variance is sample
variance. Reproduce with `node scripts/context-engine-benchmark.mjs <source-checkout>
<report.json> --hardening`. The baseline is an isolated 7321d6f9 worktree.

## Reproduction and sample limits

Baseline `1af30d16e66871ebb3509a76f0df62aaa090c263`; final local V2 sources.
Linux x64, Node 24.19.0, pnpm 11.25.0, Chromium 154.0.8037.57, headless, same
container and fixtures. Final benchmark ran without concurrent Vitest/build work.
The control source uses a detached worktree and the same dependencies.

```sh
node scripts/context-engine-benchmark.mjs /workspace/read-frog-v2-control /tmp/context-v2-performance-before.json
node scripts/context-engine-benchmark.mjs /workspace/read-frog /tmp/context-v2-performance-after.json
node e2e/context-engine/run.mjs /tmp/context-v2-browser.json
```

Each corpus retains all 1 / 100 / 1,000 / 50,000 DOM units. It acquires up to 50
distinct scopes, performs 100 warm reads and 100 resolver probes, then ten batches
of 100 reorder + insert + delete operations and one source recycling check.
Cold read has **one sample per corpus**, not a claimed P50/P95. Warm/resolve
percentiles have N=100; distinct reads N=min(50, units); churn N=10. No model calls
occur in the extraction benchmark. Physical HTTP evidence is reported separately.
Browser timing resolution is approximately 0.1 ms: 0.00 means below resolution.

The initial semantic checker failed to unescape Markdown underscores. Both control
and V2 were rerun with the corrected identical checker. Only those corrected
measurements appear below and in the archived JSON; the first checker run is not
used as correctness evidence.

## Context time and workload

Times in ms, P50/P95. A control cache hit can be fast because it incorrectly shares
one global context across unrelated posts; it does not have equivalent semantics.

| Units  | Cold control → V2 | Distinct reads control → V2 P50/P95 | Warm control → V2 P50/P95 | V2 resolver P50/P95 |
| ------ | ----------------- | ----------------------------------- | ------------------------- | ------------------- |
| 1      | 86.9 → 99.1       | 86.90/86.90 → 99.10/99.10           | 0.00/0.00 → 0.00/0.20     | 0.00/0.10           |
| 100    | 119.6 → 82.4      | 0.00/0.10 → 0.50/2.40               | 0.00/0.00 → 0.00/0.10     | 0.00/0.10           |
| 1,000  | 360.1 → 96.1      | 0.00/0.10 → 0.50/1.70               | 0.00/0.00 → 0.00/0.10     | 0.00/0.00           |
| 50,000 | 45673.0 → 2783.8  | 0.00/0.10 → 0.60/7.10               | 0.00/0.00 → 0.00/0.10     | 0.00/0.00           |

The ordinary-article cold sample regresses from 86.9 to 99.1 ms (+12.2 ms, 14%).
This includes first parser/module loading and privacy checks; N=1 is insufficient
to establish a stable cold-start regression distribution. Warm scoped reads also
pay bounded scope validation. The 50,000-unit cold sample decreases from 45,673 to
2,783.8 ms (93.9%), but **2.8 seconds remains significant**; browser layout/style
cost on a giant DOM is not eliminated by bounding the copied source.

| Units  | Churn batches control → V2 P50/P95 ms | V2 observer total ms | CPU task seconds control → V2 | Post-release GC JS heap MiB control → V2 | Long tasks count / max ms control → V2 |
| ------ | ------------------------------------- | -------------------- | ----------------------------- | ---------------------------------------- | -------------------------------------- |
| 1      | 0.40/0.80 → 2.00/3.60                 | 12.20                | 0.090 → 0.134                 | 2.78 → 2.95                              | 0 / 0 → 1 / 86                         |
| 100    | 0.50/1.80 → 1.70/3.90                 | 14.10                | 0.174 → 0.157                 | 3.05 → 2.50                              | 1 / 90 → 0 / 0                         |
| 1,000  | 1.30/2.30 → 2.30/4.70                 | 15.40                | 0.710 → 0.275                 | 3.11 → 2.58                              | 2 / 304 → 0 / 0                        |
| 50,000 | 13.90/25.30 → 2.60/3.90               | 14.60                | 96.213 → 5.598                | 6.86 → 2.97                              | 2 / 47178 → 1 / 74                     |

CPU is Chrome DevTools `TaskDuration` delta, not system-wide CPU utilization.
Heap is `JSHeapUsedSize` after explicit GC/context release while fixture DOM remains;
it excludes native DOM/process memory and is not proof of zero memory leaks.
Long tasks are PerformanceObserver entries delivered to the harness, not a native
extension main-thread trace. Control has no per-scope observer metric/export, so
its observer-only time and scope counters are **not measured**, not assumed zero.

## Cache and lifetime accounting

| Units  | V2 scope reads / hits / hit rate | Rebuilds | Body / metadata projections | Scopes before → after release | Observers after release |
| ------ | -------------------------------- | -------- | --------------------------- | ----------------------------- | ----------------------- |
| 1      | 102 / 100 / 98.0%                | 2        | 2 / 2                       | 1 → 0                         | 0                       |
| 100    | 151 / 100 / 66.2%                | 51       | 51 / 51                     | 50 → 0                        | 0                       |
| 1,000  | 151 / 100 / 66.2%                | 51       | 51 / 51                     | 50 → 0                        | 0                       |
| 50,000 | 151 / 100 / 66.2%                | 51       | 51 / 51                     | 50 → 0                        | 0                       |

All V2 corpora isolate the first source and refresh its recycled text. Control fails
feed isolation for 100/1,000/50,000 and the recycled-text check at 50,000. Churn and
recycle are combined in this benchmark; the isolated deterministic regression test,
not this benchmark, proves the own-edit invalidation defect.

Two real Chromium pages each perform 100 mount/unmount cycles, acquire 1,500 scopes,
and peak at 15 active scopes; teardown leaves zero scopes, snapshots, preparations,
work entries or observers. This is a bounded lifetime stress test, **not an hours-long
soak or a concurrent cross-tab background-sharing acceptance**. The deterministic
500-cycle cache test additionally enforces capacity 8 and one observer. Shared
consumer cancellation and overlapping-generation extraction capacity are separate
concurrency tests.

## Physical HTTP and summary cost

The paired local HTTP fixture uses identical source DOM, title, provider configuration,
SDK and background queues against control and V2. Only IPC/storage are mocked.
Control makes **2 HTTP** (one summary, one translation) and fails to render A after B
is removed. V2 makes **1 HTTP** (translation), renders A, and has zero summary RPCs:
complete short scoped source supplies the built-in prompt context. Both finish with
zero active/queued requests, lanes and timers. This demonstrates correctness with
reduced request count for this fixture, not a total-production-cost claim.

The extended V2 SDK fixture makes four HTTP requests: A translation 1; subsequent
cache read 0 (one cache hit); two shared subscribers with one cancellation 1;
explicit 429 + success 2. Summary RPCs 0. First successful A translation latency is
recorded in `http-after.json` (one local sample). Control has no successful displayed
first sentence; its response time is not a comparable display latency. Real-provider
first-token P50/P95 is unmeasured, and no paid API was used.

The Chromium rendering fixture uses a simpler local HTTP transport and the real
content/runtime DOM code: eight cases total **28 HTTP**, exactly one per necessary
translation unit, including virtual six-part and giant six-part paths. It does not
claim background SDK or native extension IPC coverage; the separate SDK test does.

Summary admission tests use mock RPC counters: 100 complete short scopes → 0;
30 equivalent explicitly requested model summaries → 1 shared RPC;
100 distinct long scopes → 1 automatic RPC + 99 visible consent errors; authorizing
one more source → total 2. These are **RPC counts**, not falsely labelled physical
HTTP. No new automatic retry budget or physical limiter was introduced.

Raw evidence: [control](evidence/performance-before.json),
[V2](evidence/performance-after.json), [browser](evidence/browser.json),
[paired HTTP control](evidence/http-before.json),
[paired HTTP V2](evidence/http-paired-after.json), [extended SDK](evidence/http-after.json).

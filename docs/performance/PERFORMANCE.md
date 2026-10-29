# Performance measurements and limitations

These are observations on the isolated 0.2.5 implementation, not a claim that every user workflow is faster. Raw samples are in [results](results/). No timing threshold is enabled in CI.

## Reproduction

Use Node >=24 and the declared pnpm 12.10.1, `pnpm install --frozen-lockfile`, then:

```sh
SKIP_FREE_API=true pnpm perf:report
PERF_SOAK_MS=1800000 SKIP_FREE_API=true pnpm perf:report benchmarks/queue.perf.ts
pnpm perf:icons
pnpm build:analyze
node scripts/build-fingerprint.mjs
pnpm check:architecture --build
PERF_BROWSER=true pnpm test:e2e e2e/ui-performance.spec.ts
```

For a production before/after run, set `PERF_EXTENSION_PATH` to the freshly rebuilt baseline or candidate extension and `PERF_LABEL` to identify it. Use a permitted Chromium environment, the same inputs/tool versions and no concurrent CPU workload. Run baseline/candidate in alternating order across multiple independent sessions. Browser observations include 3 warmups and 30 navigations for Popup, Provider Options and Hub; first-navigation samples are separate and are not independent cold-extension starts. Existing full browser regressions cover richer interactions separately.

The baseline was freshly built from `18f2c8cb`; its source, manifest, dependencies and file hashes are in [baseline.json](baseline.json). The original 0.2.4 worktree and its generated output were not used. Live free API calls are intentionally excluded; no HTTP duration is described as model inference.

## Algorithm work and UI commits

| Scenario                                           |             Reference |          Candidate | Interpretation                                                                                   |
| -------------------------------------------------- | --------------------: | -----------------: | ------------------------------------------------------------------------------------------------ |
| 5,000 paragraphs, overlapping mutation roots       | 20,250 element visits |       5,250 visits | Deterministic traversal work reduction; synchronous invalidation still runs.                     |
| Same synthetic DOM traversal, P50 / P95            |      17.16 / 22.45 ms |     4.63 / 5.84 ms | JSDOM traversal, excludes browser layout and long tasks.                                         |
| 5,000 nonoverlapping cues, 1,000 lookups, P50      |              4.677 ms |           0.201 ms | Linear predicate versus prefix-max-end binary search; index build 0.054 ms, measured separately. |
| 50,000 nonoverlapping cues, 1,000 lookups, P50     |             40.908 ms |           0.414 ms | Build 0.382 ms; no per-tick rebuild.                                                             |
| 50,000 overlapping cues, 1,000 lookups, P50        |             29.234 ms |           0.345 ms | Preserves first matching array entry, not latest start.                                          |
| Popup language UI, 30 unrelated config updates     |            30 commits |          0 commits | Equality at subscription boundary suppresses cloned but unchanged slices.                        |
| JSON editor, 30 error-decoration updates           |   30 reconfigurations | 0 reconfigurations | All 30 React commits still occur; editor state is not rebuilt.                                   |
| Transcript, 500 rows, single-cue update, P50 / P95 |       9.30 / 36.07 ms |    2.71 / 10.35 ms | React development Profiler; stable unchanged rows. Not production interaction latency.           |

All timing runs used 3 warmups and 30 measured repetitions. Subtitle and DOM comparisons alternate order. The small 100-cue overlap case did **not** improve: linear P50 approximately 0.066 ms versus indexed 0.086 ms. Index complexity benefits longer tracks; the result does not justify claiming a universal speedup. Random/boundary differential tests, rather than timings, establish semantic equivalence.

The UI scripts render actual components with storage/theme and missing JSDOM measurement APIs adapted. Profiling builds are useful for relative commits/work, not production absolute duration. The final Provider route's static build closure no longer contains CodeMirror; both the advanced field and recommendation preview must use the lazy boundary. Draft retention is separately tested. No animation, focus feature or visible result is removed.

## Concurrency decision

64 local synthetic attempts per run; fast=1 ms, slow=10 ms, burst=4 ms in waves. Persistent 429 is a scheduler simulation with deliberately compressed 2 ms pauses, not a provider benchmark. The queue still uses the existing token semantics.

| Max concurrent | Slow workload elapsed P50 | First completion P50 |
| -------------- | ------------------------: | -------------------: |
| Unbounded      |                  10.71 ms |             10.30 ms |
| 2              |                 326.07 ms |             10.25 ms |
| 4              |                 163.68 ms |             10.31 ms |
| 8              |                  82.00 ms |             10.30 ms |
| 16             |                  41.28 ms |             10.31 ms |
| 32             |                  20.87 ms |             10.34 ms |
| 64             |                  10.68 ms |             10.33 ms |

Lower limits reduce active attempts but lose throughput in this workload. Limit 64 is indistinguishable from unbounded for only 64 tasks and provides no evidence for a production resource benefit. **Default remains unbounded**. No candidate establishes a lower resource footprint with unchanged throughput/first-completion latency across representative real loads. `capacity` remains burst tokens; the optional concurrency limit neither migrates nor overrides existing user settings. [Queue semantics and noncooperative cancellation limits](REQUEST_QUEUE.md).

## Resources

The separate Node queue soak completed 1,800,124 ms, 1,782 cycles of 32 tasks, and 61 post-GC samples. Heap went from 21,049,656 to 21,238,200 bytes. After the first five samples the range was 21,102,392–21,253,456 bytes; no monotonically growing queue-resource count was observed. The final active-resource list contains three test-harness pipes and no timeout. This is bounded evidence for this workload, not a proof of no leaks in all transports or the browser.

Deterministic tests additionally cover subtitle error timers, channel closure, interrupted host setup, shadow observer detach/reuse, cancellation and late TTS audio after owner unmount. Browser DOM/node/listener counts and 30-minute TTS/offscreen/SPA/subtitle heap trends remain unverified because the managed browser prohibits extension installation.

## Bundle and dependency evidence

- Dependency versions and transitive lockfile snapshots are identical to the 0.2.5 baseline. Removed one direct Form-store dependency and reclassified Iconify/shadcn; no SDK/framework upgrade.
- All manifest fields, permissions and extension identity inputs remain unchanged. Per-file production checksums are in `results/build.json`.
- Most total-package reduction comes from regenerated license notices excluding development-only tools. JavaScript grows modestly due to request verification, cleanup/scheduling and additional load boundaries. See final byte counts in the build report; do not interpret notice compression as a runtime speed improvement.
- The isolated icon prototype covers all 77 current names: 36,317 bytes / 7,559 gzip for offline Iconify versus 23,920 / 5,855 for a Tabler name-map prototype, React external. The 1,704-byte gzip difference does not establish application initialization or property/accessibility equivalence. Existing icons are retained.
- AI SDK's baseline subtitle contribution from `ai/dist/index.js` was only 649 rendered bytes, not the entire SDK. Removing the class-identity check is a boundary/error-compatibility improvement; no large SDK size reduction is claimed.

## Provenance and acceptance

Earlier experimental reporters recorded HEAD at report-write time. In `ui-after.json`, the measured config/editor/transcript changes were uncommitted and later became `68129283`, `07b68c0a`, `9e1b6946`; its source field alone does not describe the measured worktree. In the 30-minute soak, unrelated commits landed while the process ran; the measured queue implementation was unchanged since `00806c98`. Raw files are retained without rewriting that history. The committed reporter now captures start-time HEAD, tracked-diff digest, lock digest and environment. Reproduce on a clean committed tree for release comparisons.

Local production Playwright was attempted again after building and failed waiting for the extension service worker. Managed Chromium has `ExtensionInstallBlocklist: ["*"]`; the policy was not changed. GitHub CI subsequently passed all three real-browser functional regressions and recorded paired production UI observations; see [CI_BROWSER.md](CI_BROWSER.md). A faithful visual demo and broader production performance acceptance remain outstanding. Test, boundary and data correctness assertions are hard checks. The separate CI performance job uploads raw samples/build graph and is report-only until stability analysis justifies individual thresholds.

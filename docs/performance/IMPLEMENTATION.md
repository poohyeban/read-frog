# Performance implementation ledger

Baseline: `18f2c8cbfddc3df5e4b7552a48b1731c28ac4cfd` (0.2.5).
Original `/workspace/read-frog` remains on 0.2.4 with no source changes. Implementation uses an isolated clone/worktree on `codex/perf-architecture-025`; no stash, reset or cleanup was run on the original worktree.

## Baseline evidence

- Node 24.19.0, pnpm 12.10.1, frozen install; lock file unchanged. Fresh WXT prepare and production analysis build; no reused dependencies or generated directories.
- 271 test files / 2,626 tests passed, `SKIP_FREE_API=true`, 4 workers. Live free API checks intentionally skipped.
- Production manifest 0.2.5; 162 files, 14,714,658 bytes. File hashes, tool and source identities: [baseline.json](baseline.json).
- Production Playwright extension test attempted with system Chromium. Failed waiting for the extension worker. Managed `ExtensionInstallBlocklist: ["*"]` prevents installing this extension; policy was not modified. Browser functional/performance acceptance remains pending in a permitted environment. Unit results are not a substitute for this acceptance.
- The earlier 330-test result and preexisting upstream 1.54.1 output were not used as baseline evidence.

## Delivery sequence

1. P0: provider model selection from captured config; minimal prompt snapshot and verified versioned request/cache identity.
2. P0: independently reproduced lifecycle/resource failures.
3. P1: bounded/coalesced DOM scheduling and observer/hover lifecycle.
4. P1: independent optional concurrency and batch dispatch notification.
5. P1: subtitle selection differential tests, index and incremental identity reuse.
6. P1: UI Profiler evidence and scoped rendering/loading changes.
7. P2: dependency/build graph audit, explicit boundaries, TECH_STACK.md.
8. Reproducible report-only benchmarks, full validation, changesets and reviewable PR.

Each functional unit is independently revertible. Preserve correctness commits when reverting later performance work. No release, merge, persisted-data migration or extension ID change is authorized by this implementation.

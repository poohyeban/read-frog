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

## Delivered units, completion evidence and rollback

| Stage                        | Delivered units                                            | Completion / remaining condition                                                                                                                                                                                                                     | Rollback                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0: baseline                  | `f617e704` isolated install/test/build and fingerprints    | Source/dependency/manifest match 0.2.5; 2,626 baseline tests. Production browser baseline blocked by machine policy.                                                                                                                                 | Remove only the isolated worktree if no longer needed; original worktree is untouched.                                   |
| 1: identity                  | `f9d79381`, `ed573d04`                                     | Deterministic Provider/Prompt/glossary capture, retry and stale-message regressions pass. v2 identity verified before caches.                                                                                                                        | Preserve these correctness fixes when reverting performance; old cache namespace is not migrated/deleted.                |
| 2: resources                 | `9d58f86c`, `841804c3`, `481fbce1`, `efdba0bf`, `47b4c9d3` | Each issue reproduced then fixed: timer, channels, interrupted setup, invalidated-context notification, unmounted TTS. Browser heap soak remains pending.                                                                                            | Revert a single lifecycle fix and keep its reproduction; no persisted-data change.                                       |
| 3: DOM                       | `9fed0a3d`, `44c72879`, `2075ab31`                         | Coalesced slices, observer release and hover ancestry matching pass DOM/ShadowRoot regressions; traversal work falls in the synthetic benchmark. Browser layout/long-task acceptance pending.                                                        | Revert hover, observer or scan work independently (reverse dependent edits where necessary).                             |
| 4: queues                    | `e4861bed`, `00806c98`                                     | Attempt-slot/cancel/timeout/retry/429/shared-task tests, native fetch abort and 30-minute Node soak pass. No finite default adopted.                                                                                                                 | Leave optional limit unset or revert batch wake then attempt scheduling. User rate/burst settings unchanged.             |
| 5: subtitles                 | `d574df16`, `a027a361`, `f5abaebd`                         | Original ordering and overlap/gap semantics differential-tested; query/merge identity tests pass. Large-track lookup costs decrease.                                                                                                                 | Retain semantic tests; revert incremental merge or restore linear lookup independently. Formats unchanged.               |
| 6: UI                        | `68129283`, `07b68c0a`, `9e1b6946`, `d8b0b273`, `265fa035` | Popup/CodeMirror/transcript relative Profiler evidence and editor/Hub/autosave tests pass. Production route/keyboard/focus/subtitle-follow validation pending browser CI. Hub retains mature rendering absent distinct evidence for another rewrite. | Revert each subscription/editor/transcript unit; revert `265fa035` before `d8b0b273` if undoing the whole lazy boundary. |
| 7: architecture/dependencies | `c3ef96d8`, `4d5d0610`, `3e822f12`, `c3d2e546`             | Pure config/Toast boundaries; static source and production IIFE checks; Form export consolidation; license-aware dependency classification; TECH_STACK and inventory.                                                                                | Restore corresponding source/imports, package importer entries and notices together; no user migration.                  |
| 8: evidence/CI               | `2012c176`, `c77cee3b` and documentation commits           | Raw samples, source/build fingerprints and report-only workflow. Local functional suite passes; browser acceptance is explicitly outstanding.                                                                                                        | Disable observation job or revert harness independently; keep correctness and boundary assertions.                       |

The final validation outcome and exact production byte counts are in [VALIDATION.md](VALIDATION.md). [ARCHITECTURE.md](ARCHITECTURE.md) records scope and remaining acceptance; [PERFORMANCE.md](PERFORMANCE.md) separates measurements from limitations. No claim is made that all production performance acceptance conditions are complete.

## Subsequent CI acceptance

The local-browser limitations above describe the original local runs. GitHub CI subsequently passed all three automated production extension regressions and rebuilt the fixed baseline for paired/reverse-order UI observations. See [CI_BROWSER.md](CI_BROWSER.md). Runtime code remains unchanged since `265fa035`; later commits add CI and evidence only. Production navigation gains remain unproven, and frame-scale regressions need further characterization before release. Browser long-duration heap/real-provider and manual visual acceptance remain outstanding.

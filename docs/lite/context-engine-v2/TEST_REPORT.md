# Context Engine V2 test report

The current **7321d6f9 production hardening** results and per-test RED/GREEN ledger
are in [HARDENING_REVIEW.md](HARDENING_REVIEW.md) and `evidence/hardening/`.
The following original V2 report compares 1af30d16; its earlier 2 → 1 HTTP result
must not be presented as a request reduction achieved again in this round.
Current local result: **3069 tests / 337 files passed**; 38 new hardening cases green. SDK HTTP 4 → 4; same Chromium cases 28 → 28, plus two new negative cases (30 total). Conclusion CONDITIONAL for measured feed/per-change overhead and native MV3 acceptance.

## Scope and execution state

Executed locally on 2026-11-01. Target `codex/subtitle-engine-v2` and fetched HEAD
both equal baseline `1af30d16e66871ebb3509a76f0df62aaa090c263` (zero commits/files
difference). Previous uncommitted patches were removed before this implementation.
No earlier release/patch-round results are counted as V2 acceptance.

| Check                               | Actual result                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `SKIP_FREE_API=true pnpm test`      | **336 files, 3031 tests passed**, 133.32 s, exit 0                                    |
| `pnpm fmt:check`                    | **Passed**, exit 0; all matched files use the required format                         |
| `pnpm lint`                         | **Passed**, exit 0; repository command runs Oxlint with type-aware/type-check enabled |
| `pnpm exec wxt build -b chrome`     | **Passed**, exit 0, 19.5 s; `.output/chrome-mv3`, 14.99 MB                            |
| V2 context-specific Vitest          | **52 passed**, including real SDK/queue/local HTTP fixture                            |
| Paired local HTTP reproduction      | Control fails displayed-result assertion; V2 passes with identical fixture            |
| Real Chromium DOM integration       | **8 cases passed**, 28 local HTTP; two pages × 100 lifetime cycles                    |
| Native MV3                          | **Environment blocked**, not accepted: managed extension blocklist `*`                |
| Paid/external free-provider testing | **Not executed**; free API tests use `SKIP_FREE_API=true`                             |

The complete command logs and exit codes are archived under `evidence/`.
Commands used `pnpm_config_verify_deps_before_run=false` because this managed
workspace already contains dependencies and automatic pnpm dependency verification
would attempt an unrelated reinstall. This does not disable tests, types or lint.
The installed pnpm is 11.25.0; package manager metadata requests 12.10.1.

The first full run exposed 37 failures: 30 old exact argument-shape assertions,
six context retry/unused-field expectations and one 500-cycle test exceeding its
five-second test timeout under full-suite load. New explicit owner/source fields
were added to assertions without removing source/format checks; obsolete global
context resend expectations became one immutable request; owner cancellation was
normalized to TranslationCancelledError; the stress-test harness timeout is now
20 seconds. Provider attempt budgets were not changed. A subsequent full run passed
3029 tests; the final full run above includes two additional privacy/probe regressions.
Expected jsdom navigation and SDK schema-compatibility warnings are in the raw log.

## Confirmed legacy defects and before/after evidence

The initial production baseline run had 10 failures and one passing source-replacement
negative control. Later, unchanged baseline production code was checked again in a
detached worktree with 16 behavior tests: **15 fail, one passes**. The isolated input
unmount regression additionally fails there. The complete baseline run and V2
mapping are archived in [test-ledger.json](evidence/test-ledger.json); each case has
its actual before state, phase and after status. New-interface invariant tests are
explicitly labelled as new tests, not falsely claimed to run on a baseline without
those interfaces.

| Function / confirmed cause | Code evidence and correction                                                                                                                                                                                                                       | Failure → current                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Scoped page context        | Old `webpage-context.ts` keyed a full-document projection by URL/revision; source argument had no scoped meaning. Resolver + snapshot manager now bind actual source roots and explicit dependencies.                                              | Article, generic feed, explicit quote, same-node recycle, move and shadow fixtures fail → pass                    |
| Local render invalidation  | Old CommitGate captured global content revision. A/B removal and both six-unit modes discarded valid responses. Render guard excludes context freshness.                                                                                           | Gate + bilingual six + translation-only six fail → pass                                                           |
| Manual operation ownership | Node operation still inherited PageSession request/gate cancellation; global cleanup removed its state. Explicit node owner + filtered page cleanup now preserve it.                                                                               | Both manual modes fail → pass; real PageTranslationManager Stop also passes                                       |
| Exact source identity      | Pending bilingual state could rebind an equal-text replacement before a response. Pending source-node snapshot must now match.                                                                                                                     | Equal-text replacement accepts stale result → rejects                                                             |
| Title                      | Global body revision rejected unchanged titles; an observer lag could accept an already changed title. Commit checks original title and request epoch.                                                                                             | Two title regressions fail → pass; one model mock call each                                                       |
| Input                      | Hook teardown did not end an otherwise connected input operation; source could change while context was preparing. Independent owner and pre-enqueue source guard added.                                                                           | Baseline unmount fails → passes; preparation race fails before guard → passes with zero translation enqueue       |
| Selection                  | Source inspection showed whole-document extraction without popup signal, and summary defaulted to PageSession. Captured range/source + popup signal/explicit summary consumer replace these edges.                                                 | Existing popup rerun/close and independent subscriber tests pass; no claim of a separate baseline UI reproduction |
| Custom action              | Context errors became `null`; preparation lacked cancellation; same provider ID hid transport changes. New preparation states/signals and transport identity fix these paths. Output schema descriptions also participate in context requirements. | Transport and schema-description regressions fail before fixes → pass; existing popup tests pass                  |
| Prompt data                | Chained replacements interpreted template tokens inside source/context; metadata could resemble instructions. One-pass substitution and encoded untrusted context blocks prevent structural interpolation.                                         | Three prompt-data regressions fail → pass                                                                         |

Global-context/render coupling, shared page cancellation and source scope selection
are related architecture defects. Equal-text source replacement, input teardown,
custom provider transport identity and recursive template expansion are independent
issues discovered at the integration boundary; each has its own evidence rather
than a site-specific exception.

## Development regressions caught before acceptance

These were defects in the new V2 implementation during development, **not claims
about the unchanged baseline**:

- Changing an explicit quote target failed to rebind the weak dependency index;
  detached/reinserted nodes could reuse a retained coordinator result. New descriptor
  and entry epochs fix both; snapshot tests pass.
- A hidden ancestor did not invalidate acquired descendants, and headings used raw
  textContent including translated/hidden text. Both red tests now pass using bounded
  descendant registration checks and original-source heading projection.
- Repeated generations of one scope could exceed the active extraction bound while
  lazy parsing stalled. A capacity-two fixture started five loads before the fix;
  now it starts two, releases all consumers and leaves zero registrations/observers.
- Checking an already ended document lease recreated event listeners. One hundred
  old-lease checks now add zero listeners.
- Page startup still invoked old global metadata priming independently of prompt requirements. The new red test proved one unwanted read; after removing the priming method/no-op entry/flag, it makes zero reads. All 129 page-control tests pass.
- TreeWalker rejection could inspect all 1000 opaque semantic children despite the
  nominal probe budget. The direct bounded walk now respects 96 probes.
- A hidden shadow host was outside the source privacy walk. The host chain is now
  checked, bounded and fail-closed; no private source/title reaches the snapshot.
- Explicit model-summary semantics and multi-scope automatic fanout needed admission;
  the red cost-policy tests now pass without disabling custom summaries.

See `boundary-before.json`, `capacity-before.json`, `projection-before.json`,
`summary-before.json`, `owner-before.json` and `specialist.json` under `evidence/`.
The two metadata red tests and preparation/provider red logs are summarized in the
ledger; they were executed before their corresponding fixes.

## Correctness, request and resource evidence

The real SDK HTTP fixture executes the actual background page handler, RequestQueue,
BatchQueue and ResourceScheduler; only storage and extension messaging are replaced
in-process. It refuses non-local HTTP. Paired baseline/V2 results:

| A waiting; B removed | Physical HTTP            | Summary RPC | A displayed                 | Active / queued / timers after |
| -------------------- | ------------------------ | ----------- | --------------------------- | ------------------------------ |
| Baseline             | 2: summary + translation | 1           | No (expected red assertion) | 0 / 0 / 0                      |
| V2                   | 1: translation           | 0           | Yes                         | 0 / 0 / 0                      |

Extended V2 fixture: initial translation 1, cache reread 0 / one cache hit,
two shared consumers with one cancellation 1, explicit HTTP 429 + success 2.
Total **4 physical HTTP**; zero summary RPCs; zero active/queued requests, lanes,
timers, context scopes, work entries and observers after teardown. No response
is retried just because a render is rejected. Existing zero-delta stream disconnect,
429, subtitle batch integrity, cache restoration and queue cancellation regressions
also pass in the complete suite; those core modules were not changed.

The real Chromium fixture covers bilingual and translation-only: single unit,
six virtual units and six giant paragraph descendants; independent manual translation
after real full-page Stop in each mode. Necessary HTTP counts are 1/6/6 per mode
plus 1/1 manual = **28**. The virtual six-unit cases release one response before
removing B, then require all six results to remain/display. This tests partial
render retention, not just final concatenated text. The transport is a simple local
HTTP mock; this harness does not claim native IPC or background Worker coverage.

Property/concurrency checks include a seeded 1000-step random reorder/insert/delete
sequence over 100 items; immutable snapshots; same-URL replacement/recycling;
explicit-reference changes; one-of-two consumer cancellation; 500 acquire/remove
cycles; overlapping pending extraction; route/query/hash/back-forward event/pagehide
lifecycle; original-source and wrapper/generation/config guards. All 52 context
specialists and retained mode/restore tests pass. No fake timer or added sleep masks
the render defect; the browser harness waits for the actual scheduled DOM frame.

## Reproduce the baseline HTTP comparison

The source fixture is kept outside Vitest discovery to avoid running an expected
failure in the normal suite:
`e2e/context-engine/http-baseline.test.ts.fixture`.
Copy it into `src/utils/host/translate/context/__tests__/http-paired.test.ts` in an
isolated baseline checkout and in the current checkout, run that file with Vitest,
then remove the temporary copies. Set `CONTEXT_HTTP_REPORT_PATH` to separate output
paths. Production source is never modified for this comparison. The baseline is
expected to fail the final displayed-result assertion; the output is written before
that assertion and teardown does not manufacture the failure.

## Native acceptance and delivery boundary

`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node e2e/mv3-preflight.mjs`
returns exit 2, `blocked-by-policy`, identifying
`/etc/chromium/policies/managed/extensions.json` with blocklist `*`. No unpacked
extension load was attempted and no policy was changed. Worker restart, native
extension IPC, browser-managed bfcache/frame injection, and real-site UI behavior
remain native acceptance tasks. Production build success is not a substitute.

At completion of this local validation, no push, PR, GitHub Actions, release,
extension-ID change or paid API call had occurred. Subsequent authorized branch
publication is separate from these validation results.

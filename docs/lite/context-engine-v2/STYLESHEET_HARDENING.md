# Context Engine V2 stylesheet hardening

## Scope and result

Target: `codex/subtitle-engine-v2`. Fetched HEAD and audit baseline both equal
`375115fae19dc2e072f3fd383025085e32293a89`: zero intervening commits or files.
This report records local V2 reliability validation before publication. The user
subsequently authorized committing and pushing these changes to the target branch.
No PR, Actions, release, paid/free external API, user-data reset or extension-ID
change is part of this publication.

Local correctness checks pass. Native MV3 acceptance remains blocked by managed
Chromium policy; this is **not an unconditional production/browser certification**.
The existing snapshot/owner/render/request architecture and attempt budgets remain.

## Confirmed causes and changes

| Finding                                                          | Code evidence and repair                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing link attribute changes missed global scopes             | `context/invalidation.ts` formerly recognized style content/add/remove and direct stylesheet link add/remove, but href/rel were local semantic events; media/disabled/type were absent from the observer filter. `global-style` candidates now include link href/rel/media/disabled/type/title and style mutations. Rel removal is conservatively recognized without retaining every DOM attribute's old value.                                        |
| A read during CSS loading could permanently reuse old visibility | No stylesheet completion listeners existed. Shared capture-phase load/error handlers now coalesce per owned Document/ShadowRoot; completion independently marks acquired registrations for validation.                                                                                                                                                                                                                                                 |
| IDL / CSSOM changes have no required mutation record             | Demand checks compare at most 128 weak ordinary/adopted sheet identities per root, disabled state, media and top-level rule count, plus document viewport/device scale. Overflow forces bounded source validation. No CSS text scanning, browser prototype patch or permanent polling.                                                                                                                                                                 |
| Async prompt preparation could send private stale context        | Context acquisition preceded awaited glossary preparation; no final bounded privacy proof existed before request admission. A deterministic deferred-glossary test sent old hidden context. `prompt-guard.ts` carries a weak capability through page/input/title, summary, selection and custom-action construction, checks after async preparation, and refuses with `CONTEXT_STALE` before enqueue. It does not enter the post-response render gate. |
| Explicit custom-action retry reused a rejected prepared context  | After the guard was introduced, the cached successful context remained selected across retry nonce changes. A separate RED test proved this integration defect. An explicit retry now checks it and locally reacquires if unsafe; unchanged context is reused. CSS alone never initiates extraction or a model request.                                                                                                                                |

`source-document.ts` was audited and left unchanged. Its original-source walk and
privacy predicate are reused by validation: hidden, aria-hidden, inert, opacity:0,
content-visibility:hidden, display:none, visibility:hidden/collapse, input/editable
sensitive regions and extension UI stay excluded, including ancestor/host privacy.
No safety condition was removed. Bounded walks and detached semantic checks remain;
normal hot context hits do not perform unconditional full live DOM projection.

The stylesheet signal/lifecycle gaps are one invalidation family. The async dispatch
gap is a separate integration boundary. Custom retry is an integration issue found
while adding that boundary, not falsely described as a baseline memory leak.

## RED before changes, GREEN after changes

| Phase                                         | Before                                                 | After / evidence                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Initial stylesheet unit matrix                | 15 failed, 1 passed, before production edits           | All 16 original cases pass; final suite adds 128-scope and >128-sheet bounds, 18 total. `unit-red.json`, `tests-final.json`.                                             |
| Async glossary / issued response              | 1 failed, 1 passed, before dispatch guard              | Both pass. Rejected preparation: 0 executor calls. Explicit fresh operation: 1, hidden marker absent. Already issued response: 1, remains accepted. `dispatch-red.json`. |
| Custom explicit retry                         | 1 failed after guard integration, before retry repair  | Both unsafe-refresh and unchanged-reuse controls pass. `custom-retry-red.json`.                                                                                          |
| Final added unit coverage                     | Not all are baseline-compatible failure reproducers    | Derived prompt wire identity, identical snapshot/source-proof refresh, scope capacity/overflow and valid retry controls pass. Per-case provenance in `test-ledger.json`. |
| Same final Chromium fixture on fixed baseline | 14 failed, 6 passed                                    | 20 passed, 0 failed. Both revisions use the final fixture and real computed styles. `browser-baseline.json`, `browser-final.json`.                                       |
| Full local Vitest                             | Baseline historical suite is not reused as this result | **339 files / 3093 tests passed**, 132.23 s. 24 newly added cases pass.                                                                                                  |

The initial 15 failing unit assertions include candidate-coalescing and listener
ownership requirements. In particular, the listener test fails because the old
implementation installs no listeners; it is **not evidence that old listeners leak**.
The privacy failures independently assert that hidden sentinel text remains in old
snapshots. Tests use controlled computed style without mutating the source DOM to
separate notification from the actual visibility change.

The browser matrix covers delayed href replacement with an intervening cache read,
both rel directions, link/style media, attribute and IDL disabled, CSS text,
add/remove, delayed @import, error, alternate sheet activation, opaque cross-origin
CSS, adopted membership, same-count rule editing, top-level insert/delete, viewport,
open ShadowRoot isolation, and six retained rendered translations. Baseline positives
include style text/add/remove, cross-origin insertion, shadow-local href and retained
rendering; those behaviors were not falsely claimed broken.

One intermediate fixture expected a single `disabled=false` to activate an alternate
sheet. Chromium did not apply it. The fixture now explicitly toggles true → false,
waits for the real CSS effect, and runs unchanged on both revisions. The intermediate
failure is archived as `browser-alternate-fixture-failure.json`, not counted as a
production defect or omitted from the evidence trail.

## Async and privacy boundary

The invalidation observer only marks candidates. A demanded read validates actual
eligible source; unchanged semantics retain the frozen snapshot and identity.
After asynchronous extraction, records and effective sheet state are checked before
publication; candidate verification and publication have no intervening await.
The deferred-preparation test proves a completion event cannot publish old source.

A loading sheet is not assumed to have its future effect: reads may reflect currently
applied CSS. Load/error and changed sheet inventory independently request another
check. New requests after effective CSS hides source must exclude it or fail closed.

Before a new local transport admission, the existing bounded source proof runs even
when no CSS event exists. Thus a same-count `CSSStyleDeclaration` edit is not fully
observable by ordinary cache reads, but its private stale context is refused before
new HTTP. The next explicit operation can refresh locally; there is no model retry.
The callback holds weak source references and bounded detached validation data, not
live DOM or an Entry. Derived prompt objects share this capability without serialized
fields or cache-key changes. Equal snapshot data can rebind an equivalent source proof.

Once admitted to existing queues/IPC, the PromptSnapshot is issued and immutable.
Later CSS changes do not rewrite it, cancel an otherwise valid render, increase
maxAttempts, allocate a new provider budget or automatically replay it. CSS changing
while an issued request waits in a background queue is outside the pre-admission
boundary, consistent with preserving issued prompts. This is not an atomic promise
about browser style versus remote network timing.

## Physical HTTP, snapshots and resources

| Paired workload                         | Baseline → final physical model HTTP | Interpretation                                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delayed href fixture                    | 2 → 2                                | One visible-context request, then one after hidden CSS applies. Baseline leaks the marker in the second; final excludes it.                                                                                |
| Same-count CSSOM fixture                | 2 → 2 total                          | Baseline sends initial + unsafe second. Final sends initial, refuses second with **0 HTTP**, then sends **1** for a separate explicit fresh operation. Equal totals do not imply identical attempted work. |
| Six rendered segments plus cosmetic CSS | 6 → 6                                | No additional model HTTP from CSS or demanded validation; all six rendered translations retained.                                                                                                          |
| Remaining stylesheet cases              | 0 → 0                                | CSS/network resource fetches are separate; no summary/translation model calls.                                                                                                                             |
| Whole stylesheet fixture                | **10 → 10**                          | **22 CSS GETs each**, separately counted. Final post-hide request payloads exclude the private marker.                                                                                                     |
| Real SDK/background queue fixture       | **4 → 4**                            | Initial 1, cache hit 0, two consumers with one cancelled 1, explicit safe 429 then success 2. Summary RPC 0.                                                                                               |
| Existing DOM rendering fixture          | **30 final**                         | Eight established cases 28, two source-edit negative cases 2, 1,000 cosmetic updates 0. This final rerun is not a new same-run baseline comparison.                                                        |

The final 20-case stylesheet fixture records 44 snapshot identity rebuilds across
all distinct fixtures/requirements and visibility transitions; this is not a
per-event cost. More diagnostic controlled results:

- 1,000 cosmetic stylesheet edits: **1,000 bounded validations, 0 projections,
  0 rebuilds, 0 HTTP**. Snapshot identity remains stable.
- 1,000 completion events over 128 acquired scopes: one coalesced candidate per
  registration, **0 eager projections/rebuilds**, then only the demanded scope is
  validated. Changing that scope's actual visibility in the unit test rebuilds one.
- 100 acquire/clear cycles: 200 load/error additions and 200 matching removals;
  subsequent completion events produce no manager activity.
- Browser matrix and all benchmarks release scopes, snapshots, preparations,
  extractions, shared work, observers, style listeners/states and pending style roots
  to **0**. SDK active/queued/lane/timer balances are **0**.

No changes were made to RequestQueue, ResourceScheduler, AttemptContext, Dexie,
Provider settings, persistence identities or extension ID.

## Performance and acceptance

See [PERFORMANCE.md](PERFORMANCE.md) and raw `evidence/stylesheet/performance-*.json`
for 20 cold samples per corpus, warm/resolve percentiles, variance, CPU, JS heap,
Long Tasks, source reads, actual rebuilds and request/resource counts. Separate
stylesheet benchmarks measure 128/130 sheets, 128 acquired scopes and dispatch cost.

Normal hot-read P95 remains 0.1–0.2 ms. With 128 sheets, P95 is 0.2 ms and zero source
projections. Small dispatch proof P95 is 0.1 ms; a 1,100-span fixture reaching the
2,048 body-node cap plus heading costs P95 5.8 ms. This is new privacy work at request
admission, not a general cache-hit projection. Giant DOM cold P95 remains seconds
and rises about 3.9% locally; 1,000-unit P95 rises 8.3%. No universal speedup or latency
SLA is claimed. Inventory/source bounds cannot bound browser-internal layout cost.

| Required check                  | Result                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `SKIP_FREE_API=true pnpm test`  | 339 files / 3093 tests pass; paid and live free APIs unused                                         |
| `pnpm lint`                     | Pass; Oxlint with `--type-aware --type-check` also provides type checking                           |
| `pnpm fmt:check`                | Pass; run after reports/evidence formatting                                                         |
| `pnpm exec wxt build -b chrome` | Pass, 11.3 s, MV3 output 15.01 MB; existing chunk/import warnings retained in log                   |
| Local Chromium / SDK            | 20 stylesheet cases and existing DOM fixture pass; real SDK 4 HTTP                                  |
| Native MV3                      | **Not accepted**: managed `ExtensionInstallBlocklist: ["*"]`, preflight exit 2; policy not bypassed |

Unobservable same-count/nested CSSOM and non-viewport media/animation changes may
cause conservative preparation refusal until explicit new demand. Nested @import
variants, native isolated-world IPC, service-worker restart, real popup close,
frame/navigation/back-forward behavior and prolonged native-memory soak still need
an authorized Chrome acceptance environment. These limits are recorded in
[RISK_REGISTER.md](RISK_REGISTER.md); local tests do not certify them.

## Files and reproducibility

Production changes are limited to invalidation, snapshot validation/capability
propagation and the demonstrated custom retry boundary. `source-document.ts`,
render guards, subtitle sessions/coordinators and request scheduling were audited
without architectural edits. Test changes are the two stylesheet suites, custom
retry controls, shared local browser harness, stylesheet matrix and benchmark.

`evidence/stylesheet/commands.json` records baseline, environment, commands, exit
states and evidence files. `test-ledger.json` maps every added test to its actual
RED provenance or explicitly labels it a new positive invariant. Raw Vitest,
Chromium, SDK HTTP, performance, lint/build/format and policy evidence accompany it.
No earlier task's test pass or HTTP reduction is reused as this round's acceptance.

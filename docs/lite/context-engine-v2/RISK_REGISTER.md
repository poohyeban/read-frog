# Context Engine V2 risk register

| State                        | Risk / limit                                                                                                                                           | Evidence and follow-up / rollback condition                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment blocked          | Native Chrome MV3 is not accepted. Managed `ExtensionInstallBlocklist: ["*"]` prevents loading.                                                        | `evidence/native-mv3.json`; do not bypass policy. On an authorized unmanaged browser, exercise every entry point, service-worker stop/restart, real popup close, reload, iframe injection, navigation/back/forward and cache restoration.                                                            |
| Measured limit               | Ordinary-article cold sample is 99.1 ms vs 86.9 ms; 50,000-unit first context still takes 2,783.8 ms.                                                  | N=1 cold sample; repeat distributions on target machines before claiming a cold-start SLA. Warm/resolver percentile samples and CPU/heap are archived. Investigate/revert if normal-page latency consistently exceeds the product budget.                                                            |
| Unverified in real providers | Local mocks prove source/prompt/ownership invariants, not translation quality or model obedience to untrusted-data instructions.                       | No paid requests. Review scoped context/explicit reference completeness and multilingual output on an authorized acceptance corpus. Encoded data prevents template/markup escape, not all semantic prompt injection.                                                                                 |
| Structural limit             | A generic resolver cannot infer all forum relationships or dynamic closed-shadow content.                                                              | Only proven semantic boundaries and explicit same-document quote/up links are inherited; uncertain sources stay local. More than 64 ancestors / 96 probes or 2000 context characters may omit context and is reported as bounded fallback/truncation. Never solve this by borrowing unrelated posts. |
| Frame acceptance pending     | Same-frame source ownership and open-shadow boundaries are tested; extension injection into actual third-party iframes and closed shadow trees is not. | Each content-runtime must operate in its own authorized frame. Do not pass inaccessible/foreign-frame DOM to borrow context. Native permissions/injection acceptance remains required.                                                                                                               |
| Cost/UX tradeoff             | A second distinct model-summary identity in one route requires explicit user action.                                                                   | Preserves custom model-summary semantics and the automatic one-summary boundary. Long feeds may show consent errors until approved; review localization and UI affordance in real Chrome. No automatic approval or retry expansion.                                                                  |
| Lifetime evidence limit      | Two pages × 100 cycles are not an hours-long soak or simultaneous cross-tab Worker-sharing proof.                                                      | Scoped counts and observers return to zero; SDK verifies two live consumers of one request. Heap is JS heap only, not native DOM/process memory. Run a longer native soak before production rollout.                                                                                                 |
| Existing storage boundary    | A permanently hung IndexedDB operation cannot be forcibly cancelled.                                                                                   | Subtitle coordinator has one cache read in flight, urgent/timeout boundaries and late-session guards. Existing partial-cache tests pass. Page cache reads still await DB and check cancellation before enqueue; no new universal DB recovery mechanism is claimed or introduced.                     |
| Pending module import        | Dynamic parser import itself is not abortable.                                                                                                         | V2 admits at most 128 pending extractions across generations and releases subscribers/indexes on exit; hanging admitted loads retain their closures until settlement. More work fails visibly with a capacity error instead of accumulating.                                                         |
| Compatibility cost           | Prompts with changed scoped context/data encoding and summary rule v3 miss semantically different old entries.                                         | Expected safe misses, not cache deletion. Actual unchanged requests remain eligible. Roll back if provider/language/terms/format identity ever cross-shares a wrong result.                                                                                                                          |

Rollback triggers: any source/DOM ownership false acceptance, unrelated source
render loss, hidden/private context leak, cache cross-contamination, extra unapproved
physical requests, or scope/observer counts failing to converge. Revert the coordinated
V2 implementation, not only the safety guards. No cache/config schema rollback or
user data deletion is necessary. Existing stable scheduler, queue, subtitle and Hub
architectures were deliberately retained.

## 7321d6f9 hardening follow-up

- **P1 native acceptance:** managed blocklist still prevents native MV3 loading.
  Real Chromium DOM/local HTTP pass independently; native worker restarts, IPC,
  frame injection, real popup/input interactions, bfcache and long multi-tab use
  remain to be accepted on an authorized browser. No policy was bypassed.
- **P2 visibility boundary:** the explicit capture-time/observed-mutation policy
  covers opacity zero, inert, content visibility, class hiding and Shadow ancestry.
  CSSOM changes, CSS animation progression/media changes without DOM mutations,
  and arbitrary relational selectors outside acquired dependencies can evade the
  observer. There is no claim of complete CSS hiding detection. Cached context has
  the existing five-minute TTL; do not use this engine as a secrets/DLP boundary.
  Prefer real application privacy attributes and keep sensitive values in excluded
  controls. Any reproducible leak inside the stated policy is a blocking defect.
- **P2 conservative class fallback:** class semantic checks retain at most 64 KiB of
  sanitized detached markup per bounded projection. Oversized or malformed round
  trips can cause a conservative re-extraction; they cannot allow a stale result
  solely by guessing that a class is decorative. Parser work is counted separately
  from live DOM projection. There is no model retry associated with that work.
- **Measurement limit:** the new fixed-baseline cold comparison has N=20 per corpus,
  superseding the earlier N=1 concern for this local environment only. It is not a
  portable latency SLA or a real-provider quality result. Raw CPU, heap, style/DOM
  counters, percentiles and variance are under `evidence/hardening/`.

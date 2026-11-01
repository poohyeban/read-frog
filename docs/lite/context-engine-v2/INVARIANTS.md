# Context Engine V2 invariants

1. A source is interpreted only inside its proven scope and same document/frame.
2. An unrelated scope mutation cannot revoke a task or an already rendered result.
3. Source node replacement, editing, owner end, route exit, config changes and
   render-generation loss still reject old results, with distinct reasons.
4. ContextSnapshot and PromptSnapshot are immutable after capture.
5. A scope can become context-stale while an unchanged translation unit remains valid.
6. Only actual prompt requirements cause extraction or summary preparation.
7. Shared work is reference-counted; one subscriber cannot cancel another.
8. Runtime identities never substitute for persistent request identity.
9. Identical effective requests can share; different relevant context cannot.
10. Existing valid cache entries and user configuration are retained, never cleared.
11. No new physical limiter, attempt allowance, unsafe retry or paid request replay.
12. Scope indexes, snapshots, observers and detached nodes have bounded ownership.
13. Context extraction restores original source and excludes extension UI, inputs,
    scripts and hidden sensitive contents.
14. Uncertain structural relationships degrade to local proven content; proximity
    does not create conversation ancestry.
15. Cost conflicts are explicit; model summaries never silently fan out per post.
16. No Actions, push, PR, release, paid-provider stress test or extension-ID change.

## Executable evidence map

| Invariant                                            | Direct evidence                                                                                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope isolation / no invented conversation           | `context/__tests__/scope-resolver.test.ts`, legacy article/feed/quote/shadow contracts; 1000 seeded mutations                                                   |
| Unrelated edits preserve pending and partial results | Legacy six-unit tests; Chromium six-unit partial response before B removal; SDK HTTP A/B fixture                                                                |
| Source replacement / editing / DOM ownership         | Legacy equal-text replacement, existing translation text-swap and virtual group suites, pipeline/render contracts                                               |
| Owner / route / config / source / generation reasons | `render-guard.test.ts`: owner-ended, route-changed, config-changed, source-detached, render-superseded, source-changed; separate context-stale acquisition test |
| Context and issued prompt immutability               | Snapshot freeze/recycle tests; context-stale still permits unchanged render; prepared-plan and cache identity suites                                            |
| Independent features / last-consumer cancellation    | Feature-context-lifetime, selection request-rerun, input hook unmount/edit tests, custom-action hook tests; SDK two-consumer cancellation                       |
| Bounded capacity / detach / routes / listeners       | 500-cycle capacity-eight snapshot test; pending generation capacity-two test; old lease 100 checks; Chromium 3000 total acquisitions                            |
| Original-source/privacy preservation                 | Snapshot translated/hidden/SVG/input/shadow tests and retained in-place restoration suites                                                                      |
| Stable cache identity / no unsafe sharing            | Existing translate-text/hash/provider/glossary/format tests; real SDK cache hit and shared request; snapshot fingerprints independent of moves                  |
| Summary semantics and cost                           | 100 short scopes → 0 RPC; 30 equal explicit model scopes → 1; 100 long scopes → 1 automatic + consent; one approval → total 2                                   |
| Budget/retry preservation                            | Paired HTTP 2 → 1; V2 SDK total 4 including explicit 429; existing zero-delta disconnect and queue tests in full suite                                          |

All reason diagnostics have fixed cardinality and record counts only. Context
staleness never calls the render-discard path. Context preparation can restart at
most once before enqueue; Provider budgets belong to the unchanged existing
AttemptContext. A cancelled consumer's result is ignored even if an uncancellable
local operation later resolves. This is distinct from claiming that every browser
or database operation can be physically interrupted.

## Production hardening invariants

17. A mutation notification is a candidate, not proof of new content or a render veto.
18. Decorative updates preserve the snapshot and do not duplicate live source projection;
    unknown parser-sensitive classes require bounded actual semantic verification.
19. Metadata-only prompts do not rebuild for unused body edits; a changed requested
    metadata field, link, heading, explicit quote or eligible source must be refreshed.
20. A collection affiliation belongs to the current semantic parent. Last-survivor
    memory cannot follow a member into an unproven standalone view.
21. Source eligibility includes ancestor/Shadow host privacy. Normal offscreen,
    clipped accessible and nonzero-opacity source remains eligible.
22. No new live DOM strong reference is retained by validation closures: roots and
    metadata documents are weak; detached serialized validation data is bounded.
23. Report local projection/rebuild work, mock RPCs and actual HTTP separately.

`context/__tests__/hardening.test.ts` is the per-case regression matrix. The original
capacity test now proves both candidate coalescing (one pending extraction) and the
unchanged capacity-two bound under explicit overlapping invalidations. It still
checks teardown, rather than dropping the old capacity protection.

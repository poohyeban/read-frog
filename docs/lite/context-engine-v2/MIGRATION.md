# Context Engine V2 migration

## Compatibility boundary

Target and fetched baseline are `codex/subtitle-engine-v2` at
`1af30d16e66871ebb3509a76f0df62aaa090c263`, with zero commits/files difference.
The preceding uncommitted patch round was deleted before the V2 work. Implementation and validation were completed locally before separately authorized
branch publication; they did not create a PR, trigger Actions or publish a release.

Existing user configuration, provider settings, extension ID, Dexie schema and
records are retained. ResourceScheduler, RequestQueue, BatchQueue, AttemptContext,
SubtitleSession and the dual subtitle pipeline are not rewritten. No attempt
budget or streaming default changes.

The webpage-context facade keeps its existing function signatures and adds an
optional source/requirements argument. All relevant feature callers now pass a
captured source and explicit operation lifetime. `getWebPageContextSignal` represents
route lifetime; it no longer means the lifetime of one cached context. Context
freshness remains queryable for acquisition, but is never a render gate.

## Persistent identity

Translation plan hashing/wire version remains unchanged. Keys continue to include
prepared source, effective provider/model, languages, resolved system/user prompts,
matched glossary terms, HTML/plain format and line-break behavior. Actual used
context fields are captured before execution. Runtime scope, node, owner and
generation IDs do not enter those keys. Equal effective requests still deduplicate.

Narrowing from global content to the actual article/feed item legitimately changes
the prompt. New data quoting also changes prompts which use context. Such requests
must miss old semantically different entries; no fallback is permitted just because
the URL/text matches. Exact equivalent requests still use their existing keys.
Unused context fields are no longer extracted or inserted into the request.

Summary rule identity changes from `article-context-v2` to `article-context-v3`
because title/content are now explicitly encoded as untrusted data. Old summaries
remain stored but are not claimed equivalent to the new summary prompt. There is
no schema migration, bulk delete or cache clear. Switching provider transport under
the same ID also invalidates custom-action execution identity.

## Summary semantics and explicit cost consent

A complete, untruncated short scope can supply its original context directly for
the built-in contextual prompt. It is not labelled as a model-generated summary.
A user-authored prompt that explicitly uses `webSummary` still requires a model
summary. Reusable summaries share their existing coordinator and background queue.

A route automatically admits one distinct model-summary identity. A second identity
requires the visible “Allow this source's model summary” action, which explains
possible provider charges. Page retry, selection retry and the input notification
carry this action; input then requires the shortcut again. Approval authorizes that
summary identity within the same route, never a larger retry allowance. Authorized
identities use a 128-entry LRU consent ledger. This is semantic admission, not a
second physical rate limiter. Existing scheduler and attempt limits still apply.

## Rollback

Revert the V2 source changes as one coordinated unit (context facade, consumers,
render owners, prompt assembly and cleanup). No cache/config/extension-ID migration
must be reversed. Old records were preserved. V2 summary entries use a distinct
rule version and will simply be ignored by the old implementation. Reverting only
the guard or only cleanup would reintroduce mismatched ownership and is not a safe
partial rollback.

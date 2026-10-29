# Translation execution and cache identity

The existing `SerializableProviderRef` is retained. Model construction uses its captured configuration; queued execution never resolves that provider again by ID.

A v2 request additionally carries only the selected prompt template (two strings), channel, glossary-enabled policy, content-awareness flag and existing cache tags. Non-LLM providers carry empty template strings. The sender resolves per-item glossary terms once, in the URL scope where matching is valid. Page variants select the template from the same config used for the provider; subtitle translation uses its explicit config override. No full preferences object or second copy of credentials is transmitted.

`getTranslationRequestHash` canonicalizes the request's text, language, provider reference, selected template, policy flags, format/newline semantics, matched terms and full prompt context into one JSON value. SHA-256 is prefixed with `translation:v2:`. No old cache entries are migrated or deleted. Session, scheduling and forced refresh are not cache identity. The background validates the version, channel, policy and hash **before** cache access. Old or inconsistent requests fail with a reload/retry instruction.

Batch identity includes captured provider configuration, selected template/channel, languages, context, glossary policy and glossary revision. Individual term lists stay out of batch grouping so batching remains effective. Execution uses the term union; individual fallback uses each item's original terms and retains batch/sentinel rules. Conflicting wording at the same revision is rejected before execution rather than silently dropped and cached. Retries reuse the same captured inputs.

These fields travel only over the extension's existing trusted messaging channel. Templates, source text, API keys and headers must never be logged, embedded into DOM, forwarded to page main-world code, or included in benchmark artifacts. Batch failure logging uses the error class, not a potentially reflected model response. Local provider endpoints and existing credentials/redirect isolation are unchanged.

Validation: regression first reproduced ID-based model reselection, then passed with captured configuration. Full suite after v2 implementation: 272 files, 2,643 tests passed, live free API checks intentionally skipped. Covers page/subtitle retries, stale messages, hash tampering, provider/template/policy grouping, glossary edits and sentinel/HTML marker behavior.

Rollback: preserve this correctness commit when reverting later performance changes. Reverting the v2 code only makes its namespace unused; no database downgrade is required.

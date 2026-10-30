# AGENTS.md

## Testing Notes

- `src/utils/host/translate/api/__tests__/free-api.test.ts` depends on live external translation services.
- When running tests locally as an AI agent, set `SKIP_FREE_API=true`.
- If `SKIP_FREE_API=true` is set, treat `free-api.test.ts` as intentionally skipped during local validation.

## Development Builds and CI

- Run relevant tests and builds locally during development. Keep source changes pushed to GitHub for backup; a push is not a request to run Actions.
- Build and release workflows are manual-only. Do not restore push, pull-request, tag or scheduled triggers, or dispatch Actions during iteration. Use Actions for final acceptance when the user requests it and repository access is restored.
- `pnpm zip` already builds the production extension. Do not run `pnpm build` immediately before it unless a separate build is required for a specific measurement.
- Reuse verified artifacts when production source, dependencies and build inputs are unchanged. Documentation/workflow edits do not require another extension build.
- Additional performance/baseline builds are opt-in; preserve existing measurements rather than repeating them for each commit.

## PR Notes

- PR titles must use conventional commit format, such as `fix(subtitles): ...`; avoid extra prefixes like `[codex]`.
- User-facing fixes and features should include a `.changeset/*.md` file for `@read-frog/extension` unless the change intentionally does not need a release. use conventional commit format for the changeset content.

# Translation architecture baseline

- Source HEAD: `18f2c8cbfddc3df5e4b7552a48b1731c28ac4cfd` (v0.2.5); initially clean working tree.
- Historical `11e6a71b` was not checked out. Existing cancellation, scoped queue reference counts, DOM restoration, hidden/shadow recovery, inline atoms and layout fixes are retained.
- Local baseline: 271 Vitest files / 2626 tests passed, 91.05s, `SKIP_FREE_API=true`. No paid provider calls.
- Confirmed defects: summary errors swallowed before queue retry; summary messages unscoped; completed-only context cache races; mutable prompt/model lookups after snapshot; overlapping per-callback pacers; repeated source validation for mutation records.
- Implementation order: summary error/cancellation contract; context/session and immutable plans; local work and mutation coalescing; browser measurements and final regression validation.
- Use repository-installed CLI binaries: installed pnpm 11 tries to auto-install the package-manager version in an unavailable home directory. WXT/Vitest need localhost socket permission in the cloud sandbox.
- Initial scope was local-only. The user later authorized pushing the completed code while still forbidding GitHub Actions. Publication uses a separate branch with `[skip ci]`, no PR/tag/workflow edits, and read-only verification.

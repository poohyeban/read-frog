# Validation status

Implementation source build: `265fa035da85b529b24c22a5b2a9c86137df6dc3` (later delivery commits add documentation and evidence). Baseline: `18f2c8cbfddc3df5e4b7552a48b1731c28ac4cfd`. Node 24.19.0 / pnpm 12.10.1, Linux x64. Original `/workspace/read-frog` remains clean on its original 0.2.4 commit.

| Check                                                 | Local result                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install, package snapshots and messaging patch | Installed in isolated tree; package versions/transitive snapshots unchanged from baseline; importer classification intentionally updated.                                                                                                     |
| `pnpm lint`                                           | Pass                                                                                                                                                                                                                                          |
| `pnpm type-check`                                     | Pass                                                                                                                                                                                                                                          |
| `pnpm fmt:check`                                      | Pass after formatting delivery docs and an existing table in `docs/restore/RELEASE-0.2.2.md` (whitespace only).                                                                                                                               |
| `SKIP_FREE_API=true pnpm test --maxWorkers=4`         | 277 files / 2,675 tests pass after final runtime change; live free API tests intentionally skipped.                                                                                                                                           |
| `pnpm build:analyze`                                  | Pass; full graph generated as `stats.html`.                                                                                                                                                                                                   |
| `pnpm build`                                          | Pass                                                                                                                                                                                                                                          |
| `pnpm zip`                                            | Pass; ZIP 4,629,560 bytes.                                                                                                                                                                                                                    |
| Source / production IIFE boundaries                   | Pass; 718 production modules, 2,814 local runtime edges. No runtime imports in generated content scripts.                                                                                                                                     |
| Manifest compatibility                                | All manifest fields exactly equal baseline, version 0.2.5 / MV3. Build config SHA unchanged.                                                                                                                                                  |
| Production extension Playwright                       | Local run blocked by managed browser policy; subsequent CI runs pass all three real Chromium scenarios. See production verification below.                                                                                                    |
| Production UI navigation observations                 | CI completed candidate/baseline and reverse-order repeats; no stable navigation speedup established. See CI_BROWSER.md.                                                                                                                       |
| Changesets                                            | Nine new patch records using the repository-required `@read-frog/extension` header. CLI status cannot run: this baseline does not install the `changeset` command. No dependency added just to run release tooling, and no release performed. |

## Build comparison

| Metric                   |   Baseline |  Candidate |
| ------------------------ | ---------: | ---------: |
| Unpacked files           |        162 |        167 |
| Total bytes              | 14,714,658 | 14,354,881 |
| JavaScript bytes         | 11,892,346 | 11,905,440 |
| Third-party notice bytes |    707,251 |    333,322 |

The JavaScript increase is 13,094 bytes; the net package decrease primarily reflects accurate license/dependency classification. No dependency version upgrade or feature removal explains the result. JSON editor chunks are absent from the final API-provider route's static closure; the full app still contains the editor. [Per-file hashes and manifest](results/build.json), [editor build graph comparison](results/editor-build-graph.json).

ZIP SHA-256: `ffecc2f92a73beb3e69217129af1a6b5ac407c2d7e10452df4b2380ef20b7748`. Rebuilding ZIPs can change archive metadata; compare the recorded per-file output hashes for content identity.

## Outstanding acceptance

Production browser functional/visual verification, cold-start and interaction latency, real HTTP load/default concurrency selection, and 30-minute browser DOM/listener/TTS/offscreen memory trends remain outstanding. Node/JSDOM numbers do not substitute for these checks. The existing regression workflow plus report-only performance workflow is included for an environment allowed to load extensions. See [architecture limits](ARCHITECTURE.md) and [performance provenance](PERFORMANCE.md).

## GitHub production verification

[Run 40909304740](https://github.com/poohyeban/read-frog/actions/runs/40909304740) and [run 40910641185](https://github.com/poohyeban/read-frog/actions/runs/40910641185) passed all local-equivalent checks and all three real Chromium extension scenarios: translation/DeepSeek actions/credential isolation, website Service Worker and expired contexts, and subtitle batching/AI resegmentation/reload. The opt-in production UI sampler also passed. The local managed-browser restriction remains, but automated production extension regression is now verified in CI.

These runs do not establish a visual demo, real-provider HTTP throughput, independent cold-extension launch timings, or 30-minute browser DOM/TTS/offscreen heap stability. They also do not establish a production navigation speedup; the paired observations and order-balanced repeats are recorded in `CI_BROWSER.md`.

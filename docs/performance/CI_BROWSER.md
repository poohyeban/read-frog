# Production browser verification and navigation observations

Runtime source is unchanged since `265fa035`; the last two follow-up commits only extend CI measurement. [Run 40912505833](https://github.com/poohyeban/read-frog/actions/runs/40912505833) tested PR head `b58b5360eb494177b9f73ecd9d349c5b6dfc24fe` (GitHub builds its merge ref). Both jobs succeeded, including 2,675 tests, production ZIP, import boundaries, three real Chromium regression scenarios and the production UI observations. The fixed baseline was separately installed and rebuilt at `18f2c8cb` in the same job.

Browser: Chromium 156.0.8078.4; Node 24.22.1 on the hosted Linux runner. All surface runs use a fresh extension profile, 3 warmups and 30 measured navigations to ready controls plus two animation frames. Measurements include Playwright overhead; they are not pure React CPU time or independent cold-extension launches.

## Balanced order and full results

The job runs candidate A, baseline B, baseline B again, then candidate A again. Each table cell is P50 / P95 in milliseconds. Four fresh profiles reduce order bias but do not characterize all host or scheduling noise.

| Surface         |    Candidate A1 |     Baseline B1 |     Baseline B2 |    Candidate A2 |
| --------------- | --------------: | --------------: | --------------: | --------------: |
| popup           | 232.73 / 265.59 | 214.81 / 232.75 | 201.00 / 217.58 | 216.46 / 232.73 |
| options         | 518.23 / 550.35 | 529.31 / 550.76 | 529.89 / 547.54 | 529.12 / 545.86 |
| translation-hub | 231.39 / 249.52 | 216.14 / 232.60 | 215.80 / 247.66 | 231.21 / 246.88 |

An earlier single A/B pair in [run 40910641185](https://github.com/poohyeban/read-frog/actions/runs/40910641185) measured Popup P50 201.52 vs 201.41 ms, Options 532.09 vs 514.89 ms, and Hub 216.75 vs 215.86 ms (candidate vs baseline). The apparent 17 ms Options penalty did not consistently repeat: the balanced run has Options approximately 11 ms faster in the first pair and nearly equal in the second. Conversely, Popup/Hub are roughly one frame slower in parts of the balanced run.

**No production navigation speedup is claimed. A small startup regression cannot yet be excluded.** The evidence is insufficient to attribute frame-scale differences to a specific implementation or enable timing gates. Keep this as an acceptance item before release, use independent alternating runs and browser CPU traces, and evaluate startup separately from interactive update work. Do not average these data into a universal percentage gain. The deterministic scan/query work and relative UI commit reductions remain separately evidenced; they do not imply faster navigation.

## Reproducible artifacts

- `results/ci-browser-ui-{current,baseline,baseline-repeat,current-repeat}.json`: all samples and first-navigation measurements.
- `results/ci-build.json` and `results/ci-baseline-build.json`: complete built file hashes, lock hashes, source and manifest metadata. Both baseline and candidate byte totals exactly reproduce the local builds (14,714,658 and 14,354,881 bytes).
- [Actions run and uploaded trace/ZIP/analysis artifacts](https://github.com/poohyeban/read-frog/actions/runs/40912505833). The raw UI/build records above are also committed, so they survive Actions artifact expiration.

All three functional browser scenarios pass: translation/DeepSeek actions/credential isolation; injected runtime with website Service Worker and expired contexts; subtitle timing through batching, AI recuts and extension reloads. This is automated acceptance for those scenarios. Manual visual/accessibility review beyond the tests, real-provider throughput, independently cold launches, and 30-minute browser DOM/TTS/offscreen memory measurements remain outstanding. The existing 30-minute Node queue soak does not cover them.

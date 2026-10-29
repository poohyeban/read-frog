---
"@read-frog/extension": patch
---

perf(core): reduce redundant DOM and subtitle work, preserve request identity and standardize dependency boundaries

Dispose TTS owners safely, defer Provider editors until needed, retain stable editor/transcript state, and add reproducible performance reports without unvalidated timing gates. Existing user data, Provider protocols and MV3 manifest remain compatible.

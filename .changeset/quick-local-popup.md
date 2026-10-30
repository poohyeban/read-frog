---
"@read-frog/extension": patch
---

perf(popup): load configuration controls independently of page translation state, recover failed startup requests, and load interface languages and provider selectors on demand.

fix(popup): compact the header and controls, deduplicate provider summaries, and give icon buttons, switches, and selectors accessible names.

perf(ui): defer Translation Hub execution and language detection, and load advanced JSON editors on first use while preserving hidden drafts.

perf(ui): keep simple switch and drawer transitions responsive, respect reduced motion, and avoid loading model services for unopened connection tests.

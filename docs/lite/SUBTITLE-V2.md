# Subtitle engine v2 — implementation and acceptance record

Baseline: `c2cafda89cc936a38ff0ff48d43a4f3ac497856b`, Read Frog Lite 0.2.6.
The initial workspace was clean. Baseline production build succeeded (WXT 0.21.4,
9.017 seconds). Five targeted suites / 85 tests passed. No remote writes.

## Accepted constraints

Fast and Quality have separate immutable timelines. Selection at every playback
position is Quality Ready > Fast Ready > Original, including reverse seeks. AI
segmentation never gates Fast admission. Source/translation publish together.

Rate limits, physical concurrency, speculative credit, emergency reserve, cumulative
requests and cumulative conservative token estimates are separate controls. Playback
consumption belongs to the extension installation, not a tab, video, worker or session.
It never resets automatically. A user explicitly raises limits in subtitle settings.
The initial 3,000 requests cover approximately two passes over a three-hour track with
two-second cues and four-item batches plus segmentation. 12 million conservative token
units reserve complete prompt UTF-8 bytes and capped output tokens. Twenty percent is
reserved for urgent work. These are finite protections, not a guaranteed dollar cap.
Missing usage or unknown provider pricing must remain labelled as estimates.

Every actual attempt, including malformed-output recovery, fallback and retries, must
reserve credit atomically before model dispatch. A logical cue has at most three actual
attempts. The shared batch charges each member's attempt ledger; a four-member batch
followed by individual recovery can therefore make at most nine calls (1 + 2×4).
Completed cache reads consume no model credit. Interrupted reservations are not refunded.

All model input is bounded independently by cue count, text size, media span, output cap
and pending work. Whole-track acquisition/indexing is local. Automatic context summaries
use only the current window. Full export requires an explicit action, an estimate and
confirmation for long/high-cost work, its own finite budget and bounded chunks. Failed
translation never produces a falsely complete SRT. Cancelling playback does not cancel
export subscriptions.

Stopping becomes complete only after background lease revocation is acknowledged.
Uncooperative remote calls cannot be preempted: they retain physical execution slots,
cannot publish, and cannot be silently retried while unresolved. Worker restarts invalidate
leases without clearing persistent budget debits.

## Validation requirements

Use deterministic mock providers only. Record requests, estimates, available usage,
cancellations, retries, cache hits and budget rejections. Include three-hour tracks,
100 seeks/toggles/restarts, 1/2/4× rates, concurrency one, competing tabs/export/web work,
soft/hard budget exhaustion, final-credit races, cancellation in every async stage,
30-second models, malformed responses and 429 recovery. Compare cold/warm baseline
and v2 with the same fixture and environment.

The managed Chromium policy blocks unpacked extension installation. Controlled Chromium
tests are not native MV3 or logged-in platform certification. Supply manual Chrome steps
and explicitly retain this limitation in the final report.

Implementation and validation results will be appended as they are obtained. No GitHub
push, PR, Actions change/run or release is authorized.

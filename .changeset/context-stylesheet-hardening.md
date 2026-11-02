---
"@read-frog/extension": patch
---

fix(context): validate stylesheet lifecycle and source privacy before prompt dispatch

Observe stylesheet attributes and completion through shared scoped listeners, retain unchanged snapshots and rendered translations, and reject unsafe prepared context without replaying model requests.

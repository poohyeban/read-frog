---
"@read-frog/extension": patch
---

fix(context): validate actual source changes and expire collection ownership safely

Reuse context through decorative DOM changes, preserve current-container affiliation, and exclude transparent, inert, hidden and extension-owned source ancestry without adding model requests.

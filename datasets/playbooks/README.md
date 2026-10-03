# Playbooks (ADR-091)

One file per frequently asked topic. When a question matches a playbook, Sandarbh answers
from the pages listed here instead of searching: faster, and always the right rulebook pages.

```
---
id: bid-security-emd                 # = file name, lowercase-with-dashes
title: Bid security / EMD — …
title_hi: …
triggers:                            # phrases officers type (English, Hindi, Hinglish)
  - earnest money
  - ईएमडी
context:                             # optional: one of these must also be in the question
  - bid
pages:                               # the pages that answer it, at most 12, best first
  - core-rules-gem-gtc-4-0 p.19
related:
  - performance-security
boost: 1                             # optional: narrow topics get more, so they win ties
reviewed: false                      # set true after a rules expert checks the file
---
## How to answer
- which source for which situation, what to cover, in what order
## Traps
- common mistakes
```

- Matching: whole words, case and Hindi nukta ignored. Score = words in the matched
  triggers + boost; the highest wins.
- Guidance is never evidence: no figure appears in an answer unless it is on a listed page.
- After editing: `npm run test:playbooks`, then restart the API (playbooks are read once).
- Files starting with `_` are ignored (use for drafts).

# Amendment register (ADR-094)

One file per rule whose printed text in a rulebook was later changed by a GO. When an
answer's pages include the rule's page, a current-position page or an archived amending GO,
the other pages are added and the answer shows, separately and each cited:

1. **Current position** (amending GO or a page that states the rule as it is now)
2. **Rule as printed** (rulebook page)
3. **Amended by** (GO number and date; link if the GO is archived)

```
---
id: fhb-sr-153-maternity-leave          # = file name
rule: Financial Handbook Vol II, Subsidiary Rule 153 — maternity leave
rule_hi: वित्तीय हस्तपुस्तिका खण्ड-2, सहायक नियम 153 — प्रसूति अवकाश
rule_pages:                              # where the rule is printed
  - up-fhb-vol2 p.183
current_pages:                           # optional: a page stating the current rule
  - core-rules-up-vitta-path-09-leave-rules p.9
amended_by:                              # GO number | YYYY-MM-DD | archived page or blank | what changed
  - G-4-484/X-90-216-79 | 1990-05-03 | | limit of three times removed
reviewed: false                          # true once checked against the GOs
---
Notes for the answer (optional).
```

- Lines starting with `#` in the header are comments (use them for things to confirm).
- After editing: `npm run test:amendments`, then restart the API.

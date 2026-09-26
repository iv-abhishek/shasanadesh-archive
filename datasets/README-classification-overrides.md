# Classification overrides

`classification-overrides.jsonl` holds human corrections to the order classifier
(`npm run classify:orders`). One JSON object per line; the override always wins.

```json
{"sourceId":"61#37#5#2023","tier":"A","docType":"scheme-guideline","note":"PM-KUSUM solar pump guidelines, used statewide","reviewedBy":"Abhishek","reviewedAt":"2026-09-26"}
```

Tiers: **A** generally applicable (used by Ask), **B** useful in context,
**C** routine or individual (archived only). Types: see `src/classify/rules.ts`.

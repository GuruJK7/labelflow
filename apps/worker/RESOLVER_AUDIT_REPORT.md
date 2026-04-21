# AI Resolver — Audit Report

Generated: 2026-04-21T21:53:10.917Z
Total fixtures: 117

## Overall

- **PASS**: 116 (99.1%)
- **FAIL**: 1 (0.9%)
- **GAP** (documented limitation): 0 (0.0%)
- **Total cost**: $0.5051
- **Latency p50 / p95 / p99**: 0ms / 7584ms / 9541ms

## By category

| Cat | Total | Pass | Fail | Gap | Accuracy |
|---|---|---|---|---|---|
| A | 20 | 20 | 0 | 0 | 100.0% |
| B | 15 | 14 | 1 | 0 | 93.3% |
| C | 8 | 8 | 0 | 0 | 100.0% |
| D | 10 | 10 | 0 | 0 | 100.0% |
| E1 | 5 | 5 | 0 | 0 | 100.0% |
| E2 | 5 | 5 | 0 | 0 | 100.0% |
| F | 8 | 8 | 0 | 0 | 100.0% |
| H | 8 | 8 | 0 | 0 | 100.0% |
| I | 8 | 8 | 0 | 0 | 100.0% |
| J | 15 | 15 | 0 | 0 | 100.0% |
| K | 5 | 5 | 0 | 0 | 100.0% |
| L | 10 | 10 | 0 | 0 | 100.0% |

## Failures (full detail)

### B04 — Atlántida grid típico — es Canelones

**Category**: B
**Verdict reason**: department mismatch: expected "Canelones", got "Montevideo"

**Input**:
```json
{
  "city": "Montevideo",
  "address1": "Calle 11 esquina 22",
  "address2": "",
  "zip": "",
  "province": "Montevideo",
  "country": "Uruguay",
  "customerFirstName": "María",
  "customerLastName": "González",
  "customerEmail": "test+b04@labelflow.local",
  "customerPhone": "099222333",
  "orderNotes": ""
}
```

**Expected**: {"department":"Canelones","barrio":null,"minConfidence":"medium"}

**Actual**:
```json
{
  "department": "Montevideo",
  "barrio": "centro",
  "confidence": "medium",
  "reasoning": "Calle 11 y Calle 22 are numbered streets in Montevideo's central grid. Barrio Centro chosen as default for central intersection of numbered streets (typical location in downtown Montevideo). No street number provided, so S/N used; intersection detail placed in extraObservations.",
  "deliveryAddress": "Calle 11 S/N",
  "extraObservations": "Esquina Calle 22",
  "rejected": false
}
```
**Latency**: 9688ms — **Cost**: $0.054007

---

## Recommendation

✅ **Ready for production** — accuracy (excluding gaps) = 99.1%.

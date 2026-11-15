# Eval Benchmark Results (n=3 per cell)

**Model:** `mock-model`  
**Runs per prompt (n):** 3  
**Total prompts:** 100 (25 per bucket)  
**Total runs:** 300  

### Bucket Performance (n=3 per cell)

| Bucket | Prompts | Runs (n=3/cell) | Pass Count | pass@1 Rate (n=3/cell) | Avg Score |
|---|---|---|---|---|---|
| `json_extraction` | 25 | 75 | 75 | 100.0% (n=3) | 1.000 |
| `math` | 25 | 75 | 75 | 100.0% (n=3) | 1.000 |
| `code_generation` | 25 | 75 | 75 | 100.0% (n=3) | 1.000 |
| `structured_extraction` | 25 | 75 | 75 | 100.0% (n=3) | 1.000 |
| **Overall** | **100** | **300** | **300** | **100.0% (n=3)** | **1.000** |

### Model Matrix (n=3 per cell)

| Model | json_extraction (n=3) | math (n=3) | code_generation (n=3) | structured_extraction (n=3) | Overall (n=3) |
|---|---|---|---|---|---|
| `mock-model` | 100.0% (n=3) | 100.0% (n=3) | 100.0% (n=3) | 100.0% (n=3) | 100.0% (n=3) |

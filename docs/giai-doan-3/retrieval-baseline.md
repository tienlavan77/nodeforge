<!-- Summary: Official retrieval evaluation baseline for future search changes. -->

# Retrieval Baseline

Official baseline for future retrieval changes, including HyDE:

- Weights: lexical `0.65` / semantic `0.35`
- Evaluation path: `run-retrieval-eval.mjs` through `createForgeToolRegistry().select_code_graph_candidates.execute()`
- Dataset: full 11-case retrieval evaluation
- `recall@4`: `0.523`
- `recall@8`: `0.667`

Use these numbers as the current comparison point. The older direct-selector baseline (`recall@4=0.568`, `recall@8=0.644`) is historical and must not be used for new comparisons.

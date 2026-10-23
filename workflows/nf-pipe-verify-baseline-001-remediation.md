<!-- Records the committed remediation and verification evidence for the archive baseline ticket. -->
# NF-PIPE-VERIFY-BASELINE-001 remediation evidence

- Recorded: 2026-10-02 UTC
- Remediation commit: `1a57042550ad26a7a9c1f9b62efd0ff830687aec`
- Tree: `613f2a48fe8eb299fa20e03d285e8f840d16ba68`
- Git working tree: clean after commit and verification.
- Four current test fixtures were aligned with commit-bound review evidence and idempotent root-commit behavior. Focused regression: 12 passed, 0 failed.

## Verification on the remediation commit

| Command | Exit | Result | Output SHA-256 |
| --- | ---: | --- | --- |
| `rg --files backend/tests \| rg '\.test\.[cm]?js$' \| sort \| xargs node --test` | 0 | 908 passed, 0 failed, 1 skipped | `b67e470e70e9bd1f1a3d9901a952f92392003b27503fca59b8e850873ca75c02` |
| `pnpm lint` | 0 | passed | `d76c290a38697ec7273b19bd45a6db30a9865c836dff3eaa80ccad138b3945d7` |
| `pnpm typecheck` | 0 | passed | `9614229fd39fee99d571aafde83fe3eef719d5c366944db4ba113f8dc0a806aa` |
| `pnpm validate:schemas` | 0 | passed | `c09d81c31fc1e17c3b49074ffcebfbf1191ed6aff75e4a134b071274298a13eb` |

The first full-suite run on the same commit failed only the one-second watcher latency check at 1552.7 ms; that test passed in isolation at 237.3 ms and passed in the second complete run. The first run's output digest is `3e90c0d6d62f6758d5af13b3dbb893492b9f1fbbf5efd7566af2c45c9a129d0a`.

The historical R5 Coder checkpoint remains `blocked` with `A5_VERIFICATION_BASELINE_FAILED`; its two failed artifacts and signed manifest were not changed. Earlier classification and archive evidence remain in `failure-manifest-NF-PIPE-VERIFY-BASELINE-001-clean-tree.json`.

## Review disposition

The existing independent Reviewer verdict remains `request_changes` at `2026-09-30T17:14:51.427Z`. It refers to commit `e62231a36c712dae4df2ee29f2f41823d3f77df4` and artifact `ARTIFACT-44b6b3d9-b094-4006-9759-b886463211f7` under verification policy v2. The current policy is v4, and this new full-suite run is separate command evidence. Do not reuse the old artifact as a passed v4 artifact or claim that the Reviewer approved this commit. A new immutable artifact and independent review, or an explicit human decision accepting the remaining review gap, is required for formal ticket acceptance.

On 2026-10-02, PROJECT-OWNER explicitly instructed that the ticket be marked `done` after seeing the remediation result. The `POST /forge/v1/tickets/NF-PIPE-VERIFY-BASELINE-001/human-review` attempt returned `VERIFY_ARTIFACT_MISMATCH` because the old artifact lacks current policy command evidence. The owner decision therefore closes the roadmap ticket administratively through `PUT /forge/v1/tickets/NF-PIPE-VERIFY-BASELINE-001`; it is not an independent Reviewer approval or a retroactive pass for the old artifact.

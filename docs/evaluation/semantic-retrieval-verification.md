<!-- Business purpose: keeps semantic retrieval review evidence tied to the submitted implementation.
Technical description: documents post-commit evidence publication, checksum validation and limits. -->
# Semantic retrieval verification

The checked-in capability and verification JSON files are locators. Actual results are published after implementation is committed at:

`.forge/runtime/nf/verification/semantic-retrieval/<review_commit_sha>/`

This avoids putting a commit's own hash inside that commit. Resolve the directory from Forge `git_status` on the clean submitted HEAD. The generated capability matrix and verification artifact must name that exact revision. Check the separately published artifact checksum, report checksum and each manifest file checksum against the pinned committed source.

Generated results are outside the implementation manifest. Never commit runtime evidence, SQLite sidecars or evaluation caches. Forge `run_check` supplies the executed command status and run identity; the engineering handoff publishes those actual results without inventing test coverage or review approval.

## Round 2 repair scope

- Evidence persistence uses an exclusive filesystem lock across the complete read/merge/rename transaction. Independent processes preserve attempt identities, symbol-read history, worker completions and diagnostics. A ten-second lock timeout fails closed. An orphaned lock requires operator investigation; it is never stolen automatically.
- Knowledge records require independent source, artifact and review identities and a valid source checksum. Missing identities cannot fall back to another field. Context mismatches remain rejected.
- Reviewer candidate revalidation carries the pinned revision and complete execution identities through both receipt registration boundaries.
- Capability fixtures use the current metadata/symbol interfaces and project access policy. Protected Git paths and parent traversal remain negative cases.

## Evidence limits

The capability matrix records observed test coverage. A passing test file does not establish an unexecuted role/provider/mode cross product.

The initial aggregate run also exposed four existing failures in `backend/tests/unit/mandatory-parent-subagent-discovery.test.js`: legacy delegation gating, objective validation, fallback status and automatic snapshot compaction expectations. That file is unchanged by this repair; the focused repair command excludes those unrelated legacy behavior assertions. Preserve the initial failed run in the handoff.

The portable labels retain their historical source revision and checksum. Their artifact and review provenance identify the previously submitted revision inspected for round 2. Evaluation against a newer corpus must reject stale labels, report `no_effect` when no ordering change is observed, and retain the dataset and provenance limitations. Fixture regression success does not establish production retrieval quality or independent Reviewer acceptance.

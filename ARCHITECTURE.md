<!-- Describes the repository architecture and links preserved design references for engineering navigation. -->
# NodeForge architecture

NodeForge coordinates project discovery, agent execution, verification and review.
The backend lives in `backend/src/`; the application UI lives in `ui/nextjs/`.
See [repository structure](STRUCTURE.md) and [documentation](docs/README.md).

## Responsibilities

- Application services coordinate conversations, plans and sprint execution.
- Governance validates plans, approval bindings and role/tool permissions.
- Supervisors coordinate ticket execution, review, recovery and verification.
- Index and context modules retrieve source; filesystem and Git retain source evidence.
- Infrastructure adapters provide filesystem, Git, process and persistent storage access.
- HTTP, SSE and CLI expose backend state; the UI presents that state.

Plans use validated JSON-first generation, canonical revisions and explicit
owner approval. See the [planning guide](workflows/architecture-plan-json-first-guide.md).

## Current design references

- [multi-project-lifecycle](docs/architecture/multi-project-lifecycle.md)
- [multi-project-agent-attribution](docs/architecture/multi-project-agent-attribution.md)
- [reviewer-evidence](docs/architecture/reviewer-evidence.md)
- [owner-execution-checkpoint](docs/architecture/owner-execution-checkpoint.md)
- [error-routing-recovery](docs/architecture/error-routing-recovery.md)
- [reviewer-coder-collaboration](docs/architecture/reviewer-coder-collaboration.md)
- [implementation-autonomy](docs/architecture/implementation-autonomy.md)
- [blocker-technical-reconciliation](docs/architecture/blocker-technical-reconciliation.md)
- [blocker-recovery](docs/architecture/blocker-recovery.md)
- [automatic-blocker-recovery](docs/architecture/automatic-blocker-recovery.md)
- [architecture-clarifications](docs/architecture/architecture-clarifications.md)
- [plan-decision-requests](docs/architecture/plan-decision-requests.md)
- [ticket-attempt-release](docs/architecture/ticket-attempt-release.md)
- [review-records](docs/architecture/review-records.md)
- [browser-verification](docs/architecture/browser-verification.md)
- [receipt-preserving-context-compaction](docs/architecture/receipt-preserving-context-compaction.md)

## Original V1.3 reference

These historical discussions provide context; current source and runtime role
instructions determine present behavior. Reference parts preserve reading order.
Remove their first comment lines and concatenate them to reconstruct the original.
In reference 02 restore `function ` before the signature-only examples
`login()`, `refreshSession()` and `logout()`.
The complete original text and hash remain in the restructuring inventory.

- [Original lines 1–200](docs/architecture/reference-01.md)
- [Original lines 201–386](docs/architecture/reference-02.md)
- [Original lines 387–562](docs/architecture/reference-03.md)
- [Original lines 563–717](docs/architecture/reference-04.md)
- [Original lines 718–910](docs/architecture/reference-05.md)
- [Original lines 911–1098](docs/architecture/reference-06.md)
- [Original lines 1099–1293](docs/architecture/reference-07.md)
- [Original lines 1294–1465](docs/architecture/reference-08.md)
- [Original lines 1466–1641](docs/architecture/reference-09.md)
- [Original lines 1642–1825](docs/architecture/reference-10.md)
- [Original lines 1826–2016](docs/architecture/reference-11.md)
- [Original lines 2017–2174](docs/architecture/reference-12.md)
- [Original lines 2175–2360](docs/architecture/reference-13.md)
- [Original lines 2361–2557](docs/architecture/reference-14.md)
- [Original lines 2558–2738](docs/architecture/reference-15.md)
- [Original lines 2739–2911](docs/architecture/reference-16.md)
- [Original lines 2912–3098](docs/architecture/reference-17.md)

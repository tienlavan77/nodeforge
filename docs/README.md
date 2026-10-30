<!-- Provides a navigable documentation entrypoint for engineers and project owners, separating current design references from preserved historical architecture discussions and linking the canonical runtime guidance without relocating protected role instructions. -->
# NodeForge documentation

- [Repository structure](../STRUCTURE.md)
- [Architecture overview](../ARCHITECTURE.md)
- [Runtime role instructions](../workflows/agents/)
- [Workflow guidance](../workflows/README.md)
- [JSON-first planning](../workflows/architecture-plan-json-first-guide.md)
- [Restructuring handoff (Phase A & B overview)](se-repo-restructuring-handoff.md)
- [Phase B source restructuring handoff](se-phase-b-source-restructuring-handoff.md)
- [Restructuring progress and verification receipts](se-repo-restructuring-progress.md)

## Current backend design references

- [multi-project-lifecycle](architecture/multi-project-lifecycle.md)
- [Ordinary verification sandbox design](architecture/ordinary-verification-write-sandbox.md)
- [Multi-project execution environment seam](architecture/multi-project-execution-environment-seam.md)
- [Receipt-preserving context compaction & mid-flight directive inbox](architecture/receipt-preserving-context-compaction.md)
- [multi-project-agent-attribution](architecture/multi-project-agent-attribution.md)
- [reviewer-evidence](architecture/reviewer-evidence.md)
- [owner-execution-checkpoint](architecture/owner-execution-checkpoint.md)
- [error-routing-recovery](architecture/error-routing-recovery.md)
- [reviewer-coder-collaboration](architecture/reviewer-coder-collaboration.md)
- [implementation-autonomy](architecture/implementation-autonomy.md)
- [blocker-technical-reconciliation](architecture/blocker-technical-reconciliation.md)
- [blocker-recovery](architecture/blocker-recovery.md)
- [automatic-blocker-recovery](architecture/automatic-blocker-recovery.md)
- [architecture-clarifications](architecture/architecture-clarifications.md)
- [plan-decision-requests](architecture/plan-decision-requests.md)
- [ticket-attempt-release](architecture/ticket-attempt-release.md)
- [review-records](architecture/review-records.md)
- [browser-verification](architecture/browser-verification.md)

## Preserved V1.3 architecture discussion

These historical references are retained in original reading order.
Consult current source and role guidance when assessing present runtime behavior.

- [Original lines 1–200](architecture/reference-01.md)
- [Original lines 201–386](architecture/reference-02.md)
- [Original lines 387–562](architecture/reference-03.md)
- [Original lines 563–717](architecture/reference-04.md)
- [Original lines 718–910](architecture/reference-05.md)
- [Original lines 911–1098](architecture/reference-06.md)
- [Original lines 1099–1293](architecture/reference-07.md)
- [Original lines 1294–1465](architecture/reference-08.md)
- [Original lines 1466–1641](architecture/reference-09.md)
- [Original lines 1642–1825](architecture/reference-10.md)
- [Original lines 1826–2016](architecture/reference-11.md)
- [Original lines 2017–2174](architecture/reference-12.md)
- [Original lines 2175–2360](architecture/reference-13.md)
- [Original lines 2361–2557](architecture/reference-14.md)
- [Original lines 2558–2738](architecture/reference-15.md)
- [Original lines 2739–2911](architecture/reference-16.md)
- [Original lines 2912–3098](architecture/reference-17.md)

## Historical collections

- [Documentation archive](archive/)
- [Stage 2](archive/giai-doan-2/)
- [Stage 3](archive/giai-doan-3/)
- [Historical specifications](archive/markdowns/)
- [Historical prompts](archive/prompt/)
- [Historical reports](archive/reports/)
- [Historical sprints](archive/sprints/)
- [Historical workflow plans](../workflows/archive/plans/)
- [Historical workflow reports](../workflows/archive/reports/)
- [Historical workflow discussions](../workflows/archive/discussions/)
- All 112 historical text documents have been archived with checksum inventories.
  All 23 inventoried oversized historical documents now have bounded parts;
  the final four use reversible Markdown quotations to preserve archived code examples.
  The sprint placeholder has been deleted with owner-approved narrow access.
  Backend governance/security tests, all 65 UI test files, lint, and the Next.js
  production build pass. Phase A of the restructuring handoff is accepted by AM.

## Documentation assets

Original PNG bytes are preserved in the asset inventory.

- [Background diagram](assets/bo-nen-chu.png)
- [Status bar reference](assets/prompt-satus-bar.png)
- [Stage 2 diagram A](assets/so-do-a.png)
- [Stage 2 diagram B](assets/so-do-b.png)

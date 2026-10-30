<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
7. Reviewer reviews; Reviewer does not implement.
8. Architecture Manager advises/gates architecture; it does not approve its own work.
9. Structure Indexer is deterministic infrastructure, not an AI role.
10. Node owns runtime orchestration.
11. Node does not silently redefine role authority.
12. Node validates Agent outputs before applying state transitions.
13. Deterministic verification is performed by Node where possible.
14. Raw test output is normalized before AI consumption.
15. Context is bounded per role.
16. Stale context must be invalidated.
17. Memory cannot override current authority.
18. File changes are observations, not workflow commands.
19. The UI is not the workflow authority.
20. Next Commit cannot start before dependency and review requirements are satisfied.
21. Architecture/API/dependency/scope changes require the appropriate approval.
22. Historical evidence must not silently overwrite current state.
23. Every meaningful workflow transition must be observable.
24. Workflow must be restartable from persisted state.
25. AI assists decisions; it does not bypass Forge's control model.

---

# 34. Final Architecture

Forge should evolve into:

```text
                         ┌─────────────────────┐
                         │    PROJECT OWNER    │
                         │   Human Authority   │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │        NODE         │
                         │  Control / Runtime  │
                         │     Orchestrator    │
                         └──────────┬──────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
          ▼                         ▼                         ▼
   Sprint Planning           Specialist Gates          System Services
          │                         │                         │
          ▼                         ▼                         ├─ Indexer
    Sprint Lead             Architecture Manager            ├─ Test Runner
          │                                                   ├─ Git Observer
          │                                                   ├─ Context Engine
          │                                                   ├─ State Manager
          │                                                   └─ Event Bus
          │
          ▼
       Builder
          │
          ▼
   Node Verification
          │
          ▼
      Reviewer
          │
          ▼
         Node
          │
     ┌────┼────┐
     ▼    ▼    ▼
   Next Retry Escalate
          │
          ▼
    Project Owner
```

The result is not:

> "Node becomes another Agent."

The intended model is:

> **Node becomes the control plane that coordinates specialized Agents, deterministic project services, persistent project state and eventually an AI reasoning layer.**

This preserves the existing Forge responsibilities while removing unnecessary Agent-driven orchestration and unnecessary context/token usage.

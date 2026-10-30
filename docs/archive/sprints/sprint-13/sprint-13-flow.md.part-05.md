<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
                        │
                        ▼
              ARCHITECTURE MANAGER
                        │
                        ▼
                       NODE
                        │
                        ▼
                 WEB CONTROL UI
                        │
                        ▼
                  PROJECT OWNER
                        │
                     APPROVE
                        │
                        ▼
                       NODE
                        │
                        ▼
                  SPRINT LEADER
                        │
                        ▼
                       NODE
                        │
                        ▼
                  AGENT RUNTIME
                        │
                   ┌────┴────┐
                   ▼         ▼
                BUILDER   REVIEWER
                   │         │
                   └────┬────┘
                        ▼
                       NODE
                        │
                        ▼
                 WEB CONTROL UI
                        │
                        ▼
                  PROJECT OWNER

---

# Sprint 13 Success Definition

Sprint 12 chứng minh:

"Node có thể vận hành toàn bộ Agent Operating Loop."

Sprint 13 phải chứng minh:

"Project Owner có thể trực tiếp điều hành vòng đời đó từ Web UI, thông qua Node, với Architecture Manager là đối tác trao đổi và Project Owner là Human Authority."

Không xây lại:

- Agent Runtime
- Communication Bus
- Communication Store
- Governance
- Agent Registry
- Agent Bootstrap
- Governance Orchestrator
- Runtime Persistence
- Recovery
- Builder / Reviewer

Sprint 13 chỉ xây:

Human Interface
+
Human Governance Interaction
+
Node HTTP/SSE Integration

---

# Sprint 13 Ticket Summary

NF-135  Web Control Shell
        ↓
NF-136  Owner ↔ Node Chat API
        ↓
NF-137  Realtime Agent Response Stream
        ↓
NF-138  Architecture Workspace
        ↓
NF-139  Human Decision / Approval
        ↓
NF-140  Project & Sprint Dashboard
        ↓
NF-141  Conversation / Audit History
        ↓
NF-142  Human Governance E2E

---

# Browser Milestones

NF-135 PASS
→ Browser mở được Web UI

NF-137 PASS
→ Browser chat realtime với Architecture Manager
  thông qua Node

NF-142 PASS
→ Project Owner điều hành được toàn bộ flow
  từ Web UI
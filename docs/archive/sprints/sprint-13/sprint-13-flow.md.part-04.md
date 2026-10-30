<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->

Phải chứng minh:

Web UI → Node

Node → Architecture Manager

Architecture Manager → Node

Node → Web UI via SSE

Owner Decision → Node

Decision persistence

Governance validation

Node → Sprint Leader

Sprint Leader → Node

Node → Runtime

Runtime → Builder

Builder → Node

Node → Reviewer

Reviewer → Node

Không được:

- Web UI → Agent trực tiếp
- Agent → Agent trực tiếp
- UI tự thực hiện Governance
- UI tự thay đổi Runtime State
- Tạo Chat Store riêng

---

# 14. Persistence Principle

Conversation sử dụng hạ tầng hiện có:

Web UI
   ↓
Node
   ↓
Communication Store
   +
Event Store
   +
History
   +
Memory

Không tạo:

- chat.db
- conversation.db
- agent-chat-store

mới nếu không có lý do kiến trúc bắt buộc.

---

# 15. SSE Principle

Node là SSE Source.

Agent
 ↓
Node
 ↓
SSE
 ↓
Web UI

Không:

Agent
 ↓
WebSocket
 ↓
Web UI

---

# 16. Human Decision Principle

Mọi quyết định quan trọng của Project Owner phải:

- Persist
- Audit
- Có correlation
- Replayable
- Traceable

Ví dụ:

Architecture Proposal
        ↓
Owner APPROVE
        ↓
Decision Store
        ↓
Governance Rule
        ↓
Workflow Transition

---

# 17. Security Boundary

Sprint 13 chưa triển khai Authentication/Authorization hoàn chỉnh nếu Architecture hiện tại chưa có.

Nhưng Web UI phải giữ boundary:

Web UI
   ↓
Node API
   ↓
Governance / Runtime

Không expose Agent implementation trực tiếp ra browser.

---

# 18. Quality Gates

Mỗi ticket phải chạy:

- Test mới
- HTTP regression
- SSE regression
- Governance regression
- Agent regression
- Recovery regression
- Sprint 10 regression
- Sprint 11 regression
- Sprint 12 regression
- Lint
- Typecheck
- Schema validation
- git diff --check

NF-142 phải chạy Full E2E.

---

# 19. Sprint 13 Exit Criteria

Sprint 13 PASS khi Project Owner có thể:

1. Mở Web Control UI bằng browser
2. Gửi message cho Architecture Manager thông qua Node
3. Nhận response realtime qua Node/SSE
4. Xem Architecture Proposal
5. Request Changes
6. APPROVE Architecture
7. REJECT Architecture
8. Xem Roadmap
9. Xem Sprint Plan
10. Theo dõi Sprint Leader
11. Theo dõi Runtime
12. Theo dõi Builder
13. Theo dõi Reviewer
14. Xem toàn bộ Communication History
15. Xem Owner Decisions
16. Restart Node
17. Conversation vẫn tồn tại
18. Workflow vẫn recover được

---

# 20. Final Architecture

                  PROJECT OWNER
                      HUMAN
                        │
                        ▼
                 WEB CONTROL UI
                        │
                    HTTP / SSE
                        │
                        ▼
                       NODE
                        │
                Communication Bus

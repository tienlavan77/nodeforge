<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->

- đọc repository
- code
- test
- commit

### Step 12

Builder trả:

- commit_id
- changed_files
- status

về Node.

### Step 13

Node dispatch Reviewer.

### Step 14

Reviewer trả:

- approve
- reject

về Node.

### Step 15

Node cập nhật:

- Ticket
- Sprint
- Workflow
- History
- Memory

### Step 16

Node lưu toàn bộ Communication.

### Step 17

Restart Node.

### Step 18

Verify:

- Runtime state
- Agent sessions
- Event history
- Communication history
- Recovery state

được khôi phục.

---

# 14. Quality Gates

Mỗi Ticket phải chạy:

```text
Test mới
+
Test liên quan
+
Lint
+
Typecheck
+
Schema Validation
+
git diff --check
```

Không chỉ chạy test riêng của Ticket.

Đặc biệt các ticket integration phải chạy regression:

```text
Sprint 9 Recovery
Sprint 10 Transport
Sprint 11 Governance
```

---

# 15. Forbidden Scope

Sprint 12 KHÔNG làm:

- Sandbox filesystem
- Cấm Builder đọc repository
- LLM integration
- Distributed Node
- Multi-node cluster
- Agent-to-Agent direct communication
- Thay đổi Event schema nếu không bắt buộc
- Thay đổi Session lifecycle NF-088
- Thay đổi Git workflow

---

# 16. Exit Criteria

Sprint 12 chỉ PASS khi:

```text
Project Owner
      ↓
Node
      ↓
Architecture Manager
      ↓
Node
      ↓
Sprint Leader
      ↓
Node
      ↓
Agent Runtime
      ↓
Node
      ↓
Builder
      ↓
Node
      ↓
Reviewer
      ↓
Node
```

hoạt động bằng implementation thật.

Ngoài ra:

- Owner Request được persist
- Architecture được persist
- Roadmap được persist
- Sprint Plan được persist
- Ticket provenance được enforce
- Agent communication được persist
- Agent sessions được persist
- Runtime state được persist
- Builder commit được lưu
- Reviewer result được lưu
- Memory được cập nhật
- Recovery hoạt động
- Event replay hoạt động
- Không Agent-to-Agent direct communication
- Không regression Sprint 9
- Không regression Sprint 10
- Không regression Sprint 11

---

# 17. Final Target

Sau Sprint 12:

```text
                    PROJECT OWNER
                        HUMAN
                          │
                          ▼
                        NODE
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
      ARCHITECTURE                 SPRINT
        MANAGER                    LEADER
             │                         │
             └────────────┬────────────┘
                          ▼
                         NODE
                          │
                          ▼
                   AGENT RUNTIME
                          │
                          ▼
                         NODE
                          │
                  ┌───────┴───────┐
                  ▼               ▼
               BUILDER         REVIEWER

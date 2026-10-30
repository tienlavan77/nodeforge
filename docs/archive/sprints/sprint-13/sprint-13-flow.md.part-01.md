<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
# Sprint 13 — Human Governance & Node Control UI

## Status

PLANNED

---

# 1. Sprint Goal

Xây dựng Web Control UI để Project Owner (Human) có thể:

- Chat với Architecture Manager thông qua Node
- Nhận response realtime qua SSE
- Xem Architecture Proposal
- Request Changes
- Approve / Reject Architecture
- Xem Roadmap
- Xem Sprint Plan
- Theo dõi Sprint Leader
- Theo dõi Runtime
- Theo dõi Builder / Reviewer
- Xem Conversation History
- Xem Audit
- Theo dõi Workflow

Nguyên tắc:

Project Owner
    ↓
Web Control UI
    ↓
Node
    ↓
Communication Bus
    ↓
Agent

Web UI KHÔNG gọi Agent trực tiếp.

---

# 2. Human Governance Model

Project Owner là Human Authority.

Project Owner
    ↓
Node
    ↓
Architecture Manager
    ↓
Node
    ↓
Project Owner

Architecture Manager:

- Phân tích yêu cầu
- Đề xuất Architecture
- Đưa ra Architecture Decision
- Xây Roadmap
- Chia Architecture thành Sprint
- Giải thích trade-off
- Chờ Project Owner quyết định

Project Owner:

- Trao đổi
- Yêu cầu thay đổi
- Approve
- Reject
- Ra quyết định Human Gate

Architecture Manager không tự approve proposal.

---

# 3. Chat Architecture

KHÔNG tạo Chat Store mới.

Tận dụng hạ tầng đã có:

- Agent Communication Store NF-122
- Agent Communication Bus NF-123
- Event Store
- History
- Memory
- SSE Runtime Stream NF-106
- HTTP Runtime API NF-105

Flow:

Owner Message
    ↓
Web UI
    ↓
HTTP
    ↓
Node
    ↓
Communication Store
    ↓
Communication Bus
    ↓
Architecture Manager
    ↓
Node
    ↓
Communication Store
    ↓
SSE
    ↓
Web UI
    ↓
Project Owner

Conversation phải giữ:

- message_id
- conversation_id
- correlation_id
- workflow_id
- sender
- receiver
- message_type
- content
- timestamp

---

# 4. Ticket Dependency

NF-135 — Web Control Shell
        ↓
NF-136 — Owner ↔ Node Chat API
        ↓
NF-137 — Realtime Agent Response Stream
        ↓
NF-138 — Architecture Workspace
        ↓
NF-139 — Human Decision / Approval
        ↓
NF-140 — Project & Sprint Dashboard
        ↓
NF-141 — Conversation / Audit History
        ↓
NF-142 — Human Governance E2E

---

# 5. NF-135 — Web Control Shell

## Mục tiêu

Tạo Web UI cơ bản để Project Owner có thể mở bằng browser.

## Deliverables

- src/transport/web/
- tests/unit/web/

## UI sections

- Architecture
- Conversation
- Decisions
- Roadmap
- Sprint
- Execution
- Agents

## Requirements

Web UI chỉ là Presentation Layer.

Không chứa:

- Agent logic
- Governance logic
- Runtime logic
- Persistence logic

UI chỉ giao tiếp với Node qua HTTP/SSE.

## Acceptance

- Web app khởi động
- Browser truy cập được UI

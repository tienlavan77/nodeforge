<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
        ↓
Project Owner
        ↓
APPROVE / REJECT / CHANGE
        ↓
Node

## Requirements

Decision phải được persist.

Có:

- decision_id
- owner_id
- proposal_id
- decision
- reason
- timestamp
- correlation_id

Node phải validate decision trước khi workflow transition.

Architecture Manager không tự approve.

---

# 10. NF-140 — Project & Sprint Dashboard

## Mục tiêu

Cho Project Owner xem toàn bộ operating state.

## Project

- Current Architecture
- Current Roadmap
- Current Sprint

## Agents

- Architecture Manager
- Sprint Leader
- Runtime
- Builder
- Reviewer

Hiển thị:

- READY
- RUNNING
- PAUSED
- FAILED
- COMPLETED

## Tickets

- READY
- BLOCKED
- RUNNING
- REVIEWING
- COMPLETED
- FAILED

## Runtime

- Active sessions
- Recovery
- Failures
- Current execution

---

# 11. NF-141 — Conversation & Audit History

## Mục tiêu

Cho Project Owner xem lại toàn bộ communication.

KHÔNG tạo persistence mới.

Đọc từ:

- Communication Store
- Event Store
- History

## Features

- Conversation list
- Conversation detail
- Message timeline
- Agent responses
- Owner decisions
- Correlation trace

Có thể trace:

Owner Message
 ↓
Architecture Manager
 ↓
Architecture Decision
 ↓
Roadmap
 ↓
Sprint
 ↓
Ticket
 ↓
Commit

---

# 12. NF-142 — Human Governance E2E

## Mục tiêu

Chứng minh Project Owner có thể điều hành Project thông qua Web UI.

## Scenario

Project Owner mở browser:

Web Control UI

Gửi:

"Chuẩn bị Sprint 13."

Flow:

Project Owner
      ↓
Web UI
      ↓
Node
      ↓
Architecture Manager
      ↓
Node
      ↓
Web UI

Architecture Manager trả:

- Architecture Proposal
- Roadmap
- Sprint Breakdown

Web UI stream proposal.

Project Owner:

APPROVE

Node:

persist decision
      ↓
Governance validation
      ↓
Sprint Leader

Sprint Leader trả:

- Sprint Plan
- Tickets
- Priority

Node:

Runtime
 ↓
Builder
 ↓
Reviewer

Web UI phải stream:

- Agent messages
- Sprint status
- Ticket status
- Builder status
- Reviewer result
- Completion

---

# 13. Required E2E Assertions

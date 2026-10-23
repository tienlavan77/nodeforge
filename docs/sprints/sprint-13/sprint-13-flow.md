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
- Có route/page chính
- Navigation hoạt động
- Node connection status hiển thị
- Agent status có thể hiển thị
- Không gọi Agent trực tiếp

## Kết quả

NF-135 PASS:

Browser
    ↓
Web Control UI

đã có UI.

Chưa yêu cầu chat realtime hoàn chỉnh.

---

# 6. NF-136 — Owner ↔ Node Chat API

## Mục tiêu

Cho Project Owner gửi message từ Web UI tới Node.

## Flow

Owner
 ↓
Web UI
 ↓
POST /conversations/:id/messages
 ↓
Node
 ↓
Communication Store
 ↓
Communication Bus
 ↓
Architecture Manager

## Requirements

API phải:

- Nhận Owner message
- Tạo message_id
- Giữ conversation_id
- Giữ correlation_id
- Persist trước dispatch
- Dispatch qua Communication Bus

Không:

- Web UI gọi Architecture Manager trực tiếp
- Tạo Chat Store riêng

## Acceptance

- Message persist
- Duplicate message được reject/idempotent
- Correlation được giữ
- Audit available
- Architecture Manager nhận được message

---

# 7. NF-137 — Realtime Agent Response Stream

## Mục tiêu

Stream phản hồi Architecture Manager từ Node lên Web UI.

## Flow

Architecture Manager
        ↓
Node
        ↓
Communication Store
        ↓
SSE
        ↓
Web UI

## Requirements

SSE hỗ trợ:

- Conversation messages
- Agent responses
- Workflow updates
- Decision events

Có:

- Subscribe
- Unsubscribe
- Reconnect handling
- Duplicate event protection

Tận dụng SSE infrastructure NF-106.

Không tạo WebSocket.

## Acceptance

Sau NF-137 PASS:

Browser
   ↓
Chat
   ↓
Node
   ↓
Architecture Manager
   ↓
Node
   ↓
SSE
   ↓
Browser

Project Owner có thể chat realtime với Architecture Manager thông qua Node.

---

# 8. NF-138 — Architecture Workspace

## Mục tiêu

Tạo workspace để Project Owner làm việc với Architecture Manager.

## Hiển thị

### Conversation

- Project Owner
- Architecture Manager

### Architecture

- Architecture Decisions
- Standards
- Constraints
- Architecture Plan

### Roadmap

- Current Roadmap
- Versions
- Sprint Breakdown

## Interaction

Owner có thể:

- Chat
- Request Changes
- Ask clarification
- View proposal

Chưa thực hiện Approval trong ticket này.

---

# 9. NF-139 — Human Decision / Approval

## Mục tiêu

Đưa Human Governance Gate vào Web UI.

## Decision types

- Architecture APPROVE
- Architecture REJECT
- Architecture CHANGE_REQUEST
- Roadmap APPROVE
- Sprint APPROVE

## Flow

Architecture Manager
        ↓
Proposal
        ↓
Node
        ↓
Web UI
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
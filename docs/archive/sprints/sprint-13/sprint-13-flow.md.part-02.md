<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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

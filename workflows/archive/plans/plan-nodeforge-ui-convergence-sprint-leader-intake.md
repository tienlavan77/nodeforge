# NodeForge UI Convergence — Sprint Leader Intake & Ticket Dispatch

## Mục đích

Đây là execution handoff bắt buộc cho plan `workflows/plan-nodeforge-ui-convergence.md`. Sprint Leader phải đọc plan gốc, xác minh repository evidence và tạo ticket trước khi Coder được giao code. Không giao trực tiếp phase hoặc toàn bộ plan cho một Coder.

## Quy trình Sprint Leader

1. Trước khi intake hoặc tạo ticket, Sprint Leader phải đọc `workflows/agents/sprint-leader.md`, plan gốc, local `AGENTS.md`, và component/import evidence.
2. Tạo Sprint plan có provenance tới `plan-nodeforge-ui-convergence.md`, gắn đúng `project_id` và sprint/conversation/task scope.
3. Làm phẳng thành ticket nguyên tử; mỗi ticket phải có `ticket_id`, `style`, target paths, allowed prefixes, objective, acceptance criteria, dependencies, owner role, verification và out-of-scope.
4. Validate/persist ticket qua roadmap/ticket service; không chỉ ghi Markdown và không tạo orphan ticket.
5. Dispatch qua Supervisor tới đúng Coder sau khi dependency gate pass.
6. Trước khi đánh giá ticket có code, Reviewer phải đọc `workflows/agents/reviewer.md`; sau đó dispatch Reviewer độc lập và chỉ mở ticket phụ thuộc tiếp theo khi evidence được chấp nhận.
7. Báo cáo planned/active/blocked/ready-for-review/accepted/deferred; mọi scope mới là follow-up ticket.

## Ticket backlog và DAG

| ID | Nội dung | Role | Phụ thuộc |
|---|---|---|---|
| NF-UI-CONV-001 | Baseline, canonical `ui/nextjs/app/page.jsx`, import graph, legacy/deprecation map | coder | — |
| NF-UI-CONV-002 | Shared dialog/modal primitive và migration inventory | coder | 001 |
| NF-UI-CONV-003 | Notification/error contract, backend error normalization và redaction | coder | 001 |
| NF-UI-CONV-004 | CSS domain split và responsive tokens | coder | 001 |
| NF-UI-CONV-005 | Canonical desktop Chat/Conversations/Workspace/Sprint layout | coder | 002, 003, 004 |
| NF-UI-CONV-006 | Tablet/mobile drawers và state preservation | coder | 005 |
| NF-UI-CONV-007 | Mobile Agents page, loading/error/focus/overflow behavior | coder | 002, 004 |
| NF-UI-CONV-008 | Conversation memory UI contract/drawer, scoped state và stale/refresh | coder | 003, 005 |
| NF-UI-CONV-009 | Playwright smoke: chat, agent management, memory drawer, responsive checks | coder | 006, 007, 008 |
| NF-UI-CONV-010 | Remove/deprecate duplicate and legacy components after evidence | coder | 009 |
| NF-UI-CONV-011 | Final responsive/accessibility/security/redaction/release verification | reviewer | 009, 010 |

Ticket 001–004 có thể chạy song song nếu không chồng file. Ticket 006–008 có thể chạy song song sau khi nền tảng 005 hoàn tất. Ticket 010 tuyệt đối không chạy trước 009 pass.

## Guardrails

- Mọi event, notification và task phải giữ `project_id`, `conversation_id`, `task_id` và correlation identity đúng scope.
- Không render raw event/JSON/stack trace và không ghi remote URL, secret hoặc API key vào ticket, log hay UI.
- `page.jsx` là canonical owner; legacy shell chỉ được xóa sau import audit và smoke pass.
- Mỗi ticket phải nêu test command và expected evidence; UI ticket bắt buộc có layout/responsive verification.
- Nếu Sprint Leader phát hiện dependency hoặc target path sai, chuyển trạng thái `blocked` và tạo follow-up; không tự sửa scope trong ticket đang chạy.

## Definition of Ready / Done

**Ready:** ticket schema hợp lệ, provenance và project scope đầy đủ, target/allowed paths rõ, dependency đã pass, acceptance criteria đo được, Coder role được chọn.

**Done:** code và test đúng scope, Reviewer độc lập chấp nhận, evidence lưu được, smoke/layout checks pass, không leak sensitive remote URL, và ticket status được cập nhật qua service chính thức.

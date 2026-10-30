<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
---

## Principle 02

Node là Source of Truth cho:

- Architecture
- Architecture Decisions
- Standards
- Constraints
- Roadmaps
- Sprint Plans
- Tickets
- Communications
- Events
- History
- Memory
- Runtime State
- Recovery State
- Audit Data

---

## Principle 03

Mọi giao tiếp giữa các Agent phải đi qua Node.

Không Agent nào được giao tiếp trực tiếp với Agent khác.

---

## Principle 04

Agent vẫn được phép:

- đọc repository
- sửa code
- tạo file
- chạy tooling
- commit code

Giữ nguyên theo ARCHITECTURE.md hiện tại.

---

## Principle 05

Sau mỗi Ticket hoàn thành:

Agent phải publish về Node:

- commit_id
- changed_files
- execution_summary
- status
- review_result

để phục vụ:

- audit
- history
- memory
- recovery

---

## Principle 06

Mọi quyết định quan trọng phải được persist.

Bao gồm:

- Owner Requests
- Architecture Decisions
- Roadmap Changes
- Sprint Plans
- Ticket Dispatches
- Builder Results
- Reviewer Decisions
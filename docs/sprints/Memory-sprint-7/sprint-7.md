# Sprint 7 — Events & History

## Mục tiêu

Xây dựng audit trail đầy đủ và cơ chế Project Memory nén dần theo thời gian.

Mục tiêu cuối Sprint: task tiếp theo chỉ nhận các facts liên quan từ Project Memory, không cần gửi toàn bộ lịch sử cũ.

## Phạm vi

```text
src/modules/events/
    Event publication
    Idempotency
    Subscriptions

src/modules/history/
    Raw History
    Event Store
    Task Summary
    Project Memory
    Retention
```

Pipeline:

```text
Raw History
    ↓
Event Store
    ↓
Task Summary
    ↓
Project Memory
    ↓
Task tiếp theo
```

## Nguyên tắc

- Event là dữ liệu có cấu trúc.
- Event phải có cơ chế chống xử lý trùng.
- Subscriber chỉ nhận event mình đăng ký.
- History giữ được audit trail cần thiết.
- Summary nén history thành facts hữu ích.
- Project Memory không chứa toàn bộ raw history.
- Task tiếp theo chỉ lấy facts liên quan từ Project Memory.
- Không xây UI/Transport trong Sprint 7.

---

## Backlog

| ID | Việc | Thư mục | Phụ thuộc | Size |
|---|---|---|---|---|
| NF-078 | Event Store + Event Publication | `src/modules/events/` | Sprint 6 | M |
| NF-079 | Event Idempotency | `src/modules/events/` | NF-078 | M |
| NF-080 | Event Subscriptions | `src/modules/events/` | NF-078 | M |
| NF-081 | Raw History + Audit Trail | `src/modules/history/` | NF-078 | M |
| NF-082 | Task Summary | `src/modules/history/` | NF-081 | M |
| NF-083 | Project Memory | `src/modules/history/` | NF-082 | M |
| NF-084 | Retention / History Compaction | `src/modules/history/` | NF-082/083 | M |
| NF-085 | Memory Retrieval Integration | `src/modules/history/` | NF-083 | M |
| NF-086 | Sprint 7 Integration / Exit Check | `tests/integration/` | NF-078→085 | M |

---

# NF-078 — Event Store + Event Publication

Xây nền tảng event trong:

```text
src/modules/events/
```

- Publish event có cấu trúc.
- Lưu event vào Event Store.
- Event có identity/metadata đủ để truy vết.
- Event Store phải giữ được thứ tự/thời điểm cần thiết cho audit.
- Không để subscriber tự làm source of truth.

### Definition of Done

Publish event → Event Store nhận đúng event → đọc lại được event.

---

# NF-079 — Event Idempotency

Đảm bảo cùng một event được xử lý nhiều lần không tạo side effect trùng.

Test:

```text
event A
event A
event A
```

→ chỉ xử lý một lần theo event identity.

- Duplicate event phải được nhận diện.
- Không tạo duplicate history/summary.
- Không làm sai state/memory.

---

# NF-080 — Event Subscriptions

Implement subscription trong:

```text
src/modules/events/
```

- Subscriber đăng ký event type/domain cần nhận.
- Publisher phát event.
- Chỉ subscriber phù hợp nhận event.
- Hủy subscription phải hoạt động.
- Không để subscriber xử lý event ngoài subscription.

Không xây WebSocket/API; Transport để Sprint 8.

---

# NF-081 — Raw History + Audit Trail

Xây:

```text
src/modules/history/
```

Raw History phải ghi nhận các facts/event cần thiết để audit:

```text
ai làm
làm gì
khi nào
trên task/project nào
kết quả gì
```

History phải truy vấn được theo project/task.

Không biến Raw History thành Project Memory trực tiếp.

---

# NF-082 — Task Summary

Từ Raw History/Event Store tạo Task Summary.

Ví dụ:

```text
Task X
- Builder sửa auth.js
- Test fail 1 lần
- Builder sửa lỗi
- Test pass
- Reviewer yêu cầu changes
- Builder sửa
- Reviewer approve
```

Summary phải là facts có ích cho task sau, không phải copy toàn bộ event history.

Pipeline phải giữ:

```text
Raw History → Event Store → Task Summary
```

---

# NF-083 — Project Memory

Từ Task Summary xây Project Memory.

Memory chứa các facts bền vững/relevant của project, ví dụ:

```text
Session timeout logic nằm ở src/session.js.
auth.js validate token trước khi refresh.
session.test.js bao phủ refreshSession.
```

Task sau chỉ lấy facts liên quan, không cần toàn bộ history cũ.

---

# NF-084 — Retention / History Compaction

Implement retention cho history:

```text
Raw History
    ↓
giữ đủ audit
    ↓
Task Summary
    ↓
Project Memory
```

Mục tiêu là history có thể nén/retention mà không làm mất facts cần thiết trong Project Memory.

Không xóa dữ liệu chỉ để giảm storage nếu chưa chứng minh summary/memory giữ đủ thông tin cần thiết.

---

# NF-085 — Memory Retrieval Integration

Tích hợp Project Memory để task tiếp theo có thể yêu cầu:

```text
project
task
context/topic
```

và nhận về facts liên quan.

Acceptance:

```text
Task A
  ↓
history
  ↓
summary
  ↓
memory

Task B
  ↓
memory query
  ↓
relevant facts
```

Không trả toàn bộ lịch sử cũ.

---

# NF-086 — Sprint 7 Integration / Exit Check

Ticket cuối Sprint.

Phải chứng minh:

```text
Task
 ↓
Events
 ↓
Event Store
 ↓
Raw History
 ↓
Task Summary
 ↓
Project Memory
 ↓
Task tiếp theo
 ↓
chỉ nhận relevant facts
```

## Exit Criteria

```text
[ ] Event publication pass
[ ] Idempotency pass
[ ] Subscription pass
[ ] Audit history pass
[ ] Task summary pass
[ ] Project memory pass
[ ] Retention/compaction pass
[ ] Memory retrieval chỉ trả relevant facts
[ ] Không cần gửi toàn bộ history cho task tiếp theo
[ ] Full test pass
[ ] lint pass
[ ] typecheck pass
[ ] validate:schemas pass
[ ] git diff --check pass
```

**Sprint 7 chỉ DONE khi NF-086 chứng minh được Project Memory thực sự thay thế việc truyền toàn bộ lịch sử cũ cho task tiếp theo.**

## Thứ tự triển khai

```text
NF-078
  ↓
NF-079 ──┐
NF-080 ──┘
  ↓
NF-081
  ↓
NF-082
  ↓
NF-083
  ├──→ NF-084
  └──→ NF-085
          ↓
       NF-086
          ↓
    SPRINT 7 DONE
```

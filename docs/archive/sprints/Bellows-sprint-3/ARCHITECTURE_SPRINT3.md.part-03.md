<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
```

Agent timeout cũng phải có recovery path.

---

# 45. Concurrent modification

Nhiều actor có thể cùng sửa:

```text
Builder A ──┐
Builder B ──┼──► project/
Human ──────┘
```

Node phải phát hiện concurrent modification.

Có thể có logical ownership:

```text
Task #101
  owns:
    src/auth.js
    tests/auth.test.js
```

Nếu Agent khác muốn sửa cùng file:

```text
resource already associated with Task #101
```

Đây là policy/workflow decision, không nhất thiết phải khóa file vật lý.

Node không nên âm thầm overwrite thay đổi.

---

# 46. Secrets
-e
---

# 52. Nguyên tắc "không proxy filesystem"

Không nên biến Forge thành:

```text
Agent
 ↓
Node
 ↓
read/write API
 ↓
Filesystem
```

cho mọi thao tác.

Nên:

```text
Agent ─────────► Filesystem
                  │
                  ▼
             Node Watcher
                  │
                  ▼
            Index / Events
```

Điều này giúp Agent làm việc tự nhiên như developer bình thường.

---

# 53. Cấu trúc `.forge/` đề xuất

# 66.6–66.8. Cập nhật sau đối chiếu FORGE_WORKFLOW_v2.md (Sprint Lead là Agent, routing qua Node)

> Bổ sung sau khi Sprint 3 "Bridge" đã triển khai phần lớn (NF-047→053 Done) — 3 mục dưới
> đây trích từ `ARCHITECTURE.md` mục 66.6/66.7/66.8, ảnh hưởng trực tiếp tới NF-054 (còn
> Backlog) và NF-058 (schema `agent-manifest`, Sprint 0 mở lại lần 2).

## 66.6. Sprint Lead là Agent spawn qua Agent Protocol — không phải role thụ động

Làm rõ: **Sprint Lead nhận nhiệm vụ từ Node, trả kết quả về cho Node điều phối tiếp tới
Builder/Reviewer** — cùng cơ chế NDJSON stdin/stdout qua Agent Protocol (NF-048) như
Builder/Reviewer, không phải vai trò "đứng ngoài" chỉ đọc tài liệu. Hệ quả:

- `agent-manifest.schema.json` (NF-058) áp dụng cho **Builder, Reviewer, và Sprint Lead** —
  cả 3 đều spawn process thật.
- **Chưa chốt:** Architecture Manager có spawn qua Agent Protocol giống 3 role trên hay
  không, hay hoạt động theo cơ chế khác (vd. 1 gate/specialist function bên trong Node, không
  phải process riêng). Cần quyết định trước khi NF-058 code xong phần Architecture Manager.
- Chỉ **Project Owner** chắc chắn không spawn process (con người, final authority) — dùng
  `role.schema.json` (NF-057) là đủ, không cần manifest.

## 66.7. Enforcement là reactive (chặn tiến độ), KHÔNG phải preventive (chặn hành động)

Trả lời câu hỏi "làm sao ngăn Agent tự do làm ngoài vai trò": kiến trúc hiện tại **không**
chặn Agent ghi file ngoài phạm vi ngay lúc xảy ra — đúng nguyên tắc đã ghi từ đầu
(*"Agent không bị Node khóa filesystem. Node chỉ quan sát và điều phối"*, kết luận cuối
`ARCHITECTURE.md`; mục 3/4/52 — Agent ghi trực tiếp, không qua `WRITE_FILE` API của Node).
**Xác nhận từ Project Owner:** giữ nguyên nguyên tắc này — không đổi sang sandbox OS-level.

Cơ chế guardrail thật sự là **reactive**, chặn ở tầng *tiến độ workflow* chứ không chặn ở
tầng *hành động*:
- Context Firewall (Sprint 5) — giảm khả năng lạc đề bằng cách không cho Agent thấy thứ
  ngoài phạm vi, không phải chặn ghi.
- `allowed_change_areas` + `WF-005` (đã có schema, Rule Engine đọc ở Sprint 5) — đối chiếu
  diff **sau khi** Agent đã ghi.
- Workflow gate (Reviewer duyệt, `WF-004`) — Commit không tiến được sang `APPROVED` nếu vi
  phạm, không phải ngăn hành động vi phạm xảy ra.
- **Kết quả/đánh giá giữa các Agent bắt buộc đi qua Node** (mục 66.8) — Builder ghi code
  trực tiếp (không đổi), nhưng Reviewer đọc code rồi trả **verdict qua Node** (Event có cấu
  trúc, `results/review-result.schema.json`), không viết file trung gian (`review.md` kiểu
  cũ) cho Agent khác đọc. Loại bỏ hẳn kênh giao tiếp Agent↔Agent ngoài Node.

## 66.8. Kết quả luôn qua Node; vòng lặp Node ↔ Sprint Leader ↔ Builder/Reviewer

**Nguyên tắc routing kết quả (xác nhận từ Project Owner):** Agent không còn giao tiếp trực
tiếp với nhau qua file trung gian (đúng lý do khiến workflow cũ thất bại — `COMMIT.md`/
`status.json`/`builder-report.md`/`review.md` là kênh Agent↔Agent ngoài tầm kiểm soát Node).
Builder ghi **code** trực tiếp (sản phẩm thật, không đổi). Mọi **kết quả/đánh giá** (review
verdict, tiến độ, findings) đi qua Node dưới dạng Command/Event có cấu trúc (Agent Protocol,
NF-048), validate được, Node lưu/điều phối tiếp — không có file "handoff" nào giữa 2 Agent.

**Vòng lặp Sprint Leader — Node tự động yêu cầu Sprint mới khi Sprint hiện tại hoàn tất:**

```
Node (theo dõi tiến độ Sprint hiện tại qua Task/Commit status)
   │  Sprint hoàn tất
   ▼
Node → Sprint Leader (Agent, spawn qua Agent Protocol giống Builder/Reviewer — mục 66.6)
   │  Command: "lập kế hoạch Sprint tiếp theo"
   ▼
Sprint Leader → Node
   │  Event: payload khớp roadmap/sprint.schema.json + commit.schema.json
   │  (ĐÃ CÓ SẴN từ Sprint 0 — NF-033–035, không cần schema mới)
   ▼
Node dispatch Commit đầu tiên của Sprint mới cho Builder → lặp lại chu trình
```

**Việc cần làm khi tới Sprint 6 (Workflow Engine) — ghi nhận, không code ngay:** thêm đúng 1
cặp Command/Event mới vào vocabulary Agent Protocol (mục 40, 12 verb hiện có chưa có verb
nào cho việc này) cho hành động "yêu cầu lập Sprint mới" / "trả về kế hoạch Sprint mới" —
chốt tên theo đúng quy trình đã dùng ở NF-047b (tên chốt trước khi code, domain nối tiếp
`sprints.*`/`roadmap.*` đã có, không phát minh casing mới).

**Việc cần sửa ngay ở Sprint 3 (NF-054 vẫn đang Backlog, chưa Done):** integration test hiện
tại chỉ test luồng kiểu Builder ("ghi file thật"). Cần bổ sung luồng kiểu Reviewer (đọc file,
trả verdict qua Node, KHÔNG viết file trung gian) trước khi coi NF-054 hoàn chỉnh — xem cập
nhật ticket bên dưới.

---

<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
Node quản lý trạng thái project thế nào.

## 3. Schema

Task / Rule / Workflow / Context / Event / Result.

## 4. Filesystem Watch + Code Index

Cơ chế đồng bộ project state.

## 5. Failure/Recovery

Crash, timeout, cancel, retry, concurrent edits.

---

# 59. Những thứ nên để sau
-e
---

## 63.1. Quan hệ Commit ↔ Task — quyết định thiết kế bắt buộc phải chốt

`project/task.schema.json` (README, Sprint 2) đã là entity **runtime** Node quản lý trong
lúc thực thi. Roadmap/Sprint/Commit ở đây là **PLAN** — nếu để cả hai khái niệm tồn tại độc
lập, dễ chồng chéo ("Commit" và "Task" cùng mô tả 1 đơn vị công việc nhưng 2 schema khác
nhau, dữ liệu dễ lệch nhau).

**Quyết định:** Commit thuộc tầng PLAN (định nghĩa *"phải làm gì"*, viết trước khi chạy).
Task là tầng RUNTIME (định nghĩa *"đang làm đến đâu"*, Node tự sinh ra khi Commit Dispatcher
giao việc cho Builder). Một Commit khi được dispatch sẽ tạo **đúng 1** Task runtime tương
ứng; Task đó giữ thêm field tham chiếu ngược `commit_id` (optional trong
`project/task.schema.json`, bổ sung khi Builder code Sprint 2 — không thuộc phạm vi 3 schema
mới ở mục 63.3, không tạo schema Commit-runtime riêng để tránh nhân đôi khái niệm).

```text
ROADMAP (PLAN)                          RUNTIME
─────────────────                       ─────────────────
roadmap.json
  └── sprint
        └── commit ──── dispatch ────▶ task (project/task.schema.json)
                                           │ commit_id ──▶ trỏ ngược về commit
                                           ▼
                                       task.status / task.workflow_state
                                       (README — không đổi)
```

Commit **không** có `status` runtime riêng (không lặp lại `pending/active/...` như Task) —
tiến độ luôn đọc qua Task đã dispatch từ Commit đó. Điều này giữ đúng nguyên tắc "tách PLAN
khỏi STATE" ở mục 63.2 bên dưới: nếu Commit tự có `status`, `roadmap.json` sẽ lại lẫn state
vào plan — đúng lỗi mà README v1.2 và mục 12 (file_id) đã tránh cho các trường hợp khác.

## 63.2. Tách PLAN khỏi STATE

Không để `roadmap.json` chứa runtime state kiểu:

```json
{
  "status": "building",
  "attempt": 3,
  "review_status": "pending"
}
```

Layout `.forge/` (đã cập nhật ở mục 53):

```text
.forge/
├── roadmap/
│   └── roadmap.json        ← PLAN, có thể commit
│
└── runtime/
    └── state.json          ← RUNTIME (sprint-state, commit-state gộp chung file này,
                                không tạo thư mục state/ riêng — runtime/ đã tồn tại
                                sẵn từ mục 6/53, tránh nhân đôi khái niệm "vùng runtime")
```

- **Roadmap** nói: "phải làm gì".
- **State** (`runtime/state.json`) nói: "đang làm đến đâu".
- **Node** nói: "bây giờ phải làm gì" (suy ra từ 2 cái trên + Commit Dependency Resolver).

Phân tách này quan trọng để Forge resume sau crash, retry Builder, chạy lại verification,
hoặc chuyển project mà không sợ lẫn dữ liệu kế hoạch với dữ liệu tiến độ.

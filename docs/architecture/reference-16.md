<!-- Preserves original architecture reference lines 2739–2911 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
## 63.6. Flow thực thi

```text
roadmap.json
      │
      ▼
roadmap.schema validation
      │
      ▼
Sprint Engine
      │
      ▼
Commit Dependency Resolver
      │
      ▼
Commit Dispatcher ──▶ tạo Task runtime (project/task.schema.json, commit_id trỏ ngược)
      │
      ▼
Builder
```

---

# 64. Cây `schemas/` tổng thể sau khi thêm Verification + Roadmap

Cập nhật lại cây `schemas/` ở README v1.2 (`core/ node/ project/ context/ results/`) với 2
nhóm mới ở mục 62–63:

```text
schemas/
├── core/                  # Envelope, Agent, Event, Command, Error, Common (README v1.2)
├── node/                  # Node profile — allOf tham chiếu core (README v1.2)
├── project/                # Project, Task, Rule, Permission, Workflow, Session (README v1.2)
├── context/                 # Context Pack — Token Firewall (README v1.2)
├── results/                 # test-result, check-result, review-result (README v1.2)
├── verification/             # MỚI — mục 62: plan/run/result/test-failure/policy
│   ├── verification-plan.schema.json
│   ├── verification-run.schema.json
│   ├── verification-result.schema.json
│   ├── test-failure.schema.json
│   └── verification-policy.schema.json
└── roadmap/                  # MỚI — mục 63: roadmap/sprint/commit
    ├── roadmap.schema.json
    ├── sprint.schema.json
    └── commit.schema.json
```

`verification/` và `roadmap/` không đụng tới field hay enum đã chốt trong `core/` (nguyên
tắc "một enum, không nhân đôi" README v1.2 vẫn giữ nguyên) — chúng chỉ tham chiếu qua ID
(`result_ref`, `commit_id`) tới các record đã có schema riêng, không tự định nghĩa lại.

> Lưu ý: cây `schemas/` này cần được phản ánh song song vào `README.md` (nguồn mô tả chính
> thức của bộ schema) khi Builder thực sự tạo các file trên — nằm ngoài phạm vi cập nhật
> lần này (chỉ `ARCHITECTURE.md`).

---

# 65. Kiến trúc tổng thể — Verification Engine + Roadmap là 2 subsystem chính, không phải tiện ích phụ

Cập nhật mô hình ở mục 2:

```text
ROADMAP (PLAN)
   │
   ▼
NODE ORCHESTRATOR
   │
   ├── Roadmap / Sprint Engine   ← mới, mục 63
   ├── Task Dispatcher
   ├── Context Builder
   ├── Rule Engine
   ├── File Watcher
   ├── Code Indexer
   ├── Verification Engine       ← mới, mục 62 — không còn là "test runner" đơn giản
   ├── Workflow Engine
   └── Event/Stream Server
           │
           ├────────► BUILDER
           │
           └────────► REVIEWER
```

---

# 66. Đối chiếu `FORGE_WORKFLOW_v2.md` — 4 quyết định đã chốt

> ⚠️ **Ghi chú quan trọng, đọc trước khi dùng mục này:** `FORGE_WORKFLOW_v2.md` tự dẫn chiếu
> tới `CONSTITUTION.md` và `WORKFLOW.md` như tài liệu nền. Khi đối chiếu 2 file đó (đã upload
> sau), phát hiện: **đây là tài liệu của một dự án Forge trước đây đã thất bại — không được
> dùng lại.** Cụ thể, `WORKFLOW.md` quy định cấu trúc thư mục `sprints/<id>/commits/<id>/
> {COMMIT.md, status.json, builder-report.md, review.md, changes.diff}` + `decisions.md` +
> `report.md` per sprint — **Nodeforge không dùng mô hình này**. Cách vận hành thật của dự án
> Nodeforge (xuyên suốt Sprint 0–3) là 1 file `SPRINT_PLAN.md` duy nhất + ticket dạng bảng
> markdown (`NF-XXX`) + báo cáo Builder gửi trực tiếp qua chat — **giữ nguyên, không đổi**.
> Nếu 2 file `CONSTITUTION.md`/`WORKFLOW.md` xuất hiện lại trong tương lai, không coi là
> nguồn sự thật cho Nodeforge.
>
> 4 quyết định dưới đây **vẫn giữ nguyên như bản gốc** (không sửa lại theo `WORKFLOW.md`,
> vì tài liệu đó không áp dụng) — chỉ đối chiếu với chính `FORGE_WORKFLOW_v2.md`.

Tài liệu `FORGE_WORKFLOW_v2.md` (đề xuất Node làm control plane điều phối Project Owner /
Sprint Lead / Builder / Reviewer / Architecture Manager) được đánh giá và đối chiếu với thiết
kế hiện có (Sprint 0–3). Phần lớn tài liệu **khớp** với nguyên tắc đã có (Node deterministic
không phải Agent khác, watcher chỉ là input signal không phải workflow authority, Context
Firewall, Test Result Compression ≈ `test-failure.schema.json` đã build). 4 điểm xung đột cụ
thể đã được chốt như sau — ràng buộc cho Sprint 5–8 khi lên ticket thật, không tự ý đặt lại.

## 66.1. `status.json` = `.forge/runtime/state.json` — không phải 2 file khác nhau

Tài liệu gọi artifact vòng đời Commit là `status.json`. Đây **là cùng một khái niệm** với
`.forge/runtime/state.json` đã build ở Sprint 2 (mục 63.2 — tách PLAN khỏi STATE:
`roadmap/roadmap.json` = PLAN, `runtime/state.json` = STATE). Không tạo file `status.json`
mới. Khi lên ticket Workflow Engine (Sprint 6) đọc/ghi vòng đời Commit
(`PLANNED → IN_PROGRESS → READY_FOR_REVIEW → REVIEWING → APPROVED/BLOCKED`), dùng đúng
`runtime/state.json` đã có, không tạo artifact song song.

## 66.2. `structure.md` là artifact MỚI, khác Code Index (`index.db`) đã có

`structure.md` (Forge Core Structure Indexer) là file giải thích cấu trúc cơ bản của dự án
mục tiêu — đặt ở **thư mục gốc của dự án** (không phải `.forge/`). Đây là artifact hoàn toàn
mới, chưa có ticket nào build:

- **Khác Code Index (`index.db`, Sprint 1 — NF-017→022):** `index.db` là dữ liệu chi tiết
  cấp symbol (SQLite, `files/symbols/imports_exports/calls/dependency_edges`) phục vụ
  dependency graph và incremental indexing. `structure.md` là tổng quan cấp thư mục, dạng
  markdown, con người đọc được, tương tự cách `STRUCTURE.md` mô tả chính repo Nodeforge —
  nhưng đây là bản Forge **tự sinh cho từng project mục tiêu** đang giám sát, không phải
  file tĩnh viết tay.
- Vì đặt ở thư mục gốc dự án (không phải `.forge/runtime/`), cần quyết định thêm khi lên
  ticket thật: `structure.md` có nên commit vào Git của project mục tiêu không (giống tinh
  thần "tài liệu sống" hữu ích cho người đọc repo), hay coi là file sinh tự động cần
  `.gitignore`? Chưa chốt — để ticket Sprint xây dựng thật (có thể Sprint 5 hoặc muộn hơn)
  quyết định cùng lúc với việc code, không quyết định suông ở đây.
- Loại trừ credentials, `.env`, dependency cache, generated output, path bị ignore — đúng
  như tài liệu gốc mô tả.

## 66.3. Schema trùng lặp — dùng bản đã build, không tạo lại

Đối chiếu bộ schema đề xuất ở tài liệu (mục 31 gốc) với 33 schema đã có (Sprint 0–3):

| Đề xuất trong tài liệu | Dùng bản đã có (KHÔNG tạo mới) |
|---|---|
| `task.schema.json` | `project/task.schema.json` (baseline + NF-040, có `commit_id`) |
| `verification-result.schema.json` | `verification/verification-result.schema.json` (NF-030) |
| `review-result.schema.json` | `results/review-result.schema.json` (baseline) |
| `sprint-plan.schema.json` | `roadmap/roadmap.schema.json` + `sprint.schema.json` + `commit.schema.json` (NF-033–035) |

Các schema còn lại trong đề xuất (`role.schema.json`, `agent-manifest.schema.json`,
`agent-capability.schema.json`, `agent-task.schema.json`, `execution-state.schema.json`,
`execution-event.schema.json`, `decision.schema.json`, `specialist-gate.schema.json`,
`human-decision.schema.json`) **là khái niệm mới thật**, chưa có bản tương đương — hình
thành từ các role mới (Project Owner, Sprint Lead, Architecture Manager chính thức hoá) và
Decision Agent tương lai. Xây khi sprint sở hữu tính năng đó tới lượt (Sprint 5–8), không
xây trước.

## 66.4. Event naming — giữ nguyên convention đã có, KHÔNG dùng SCREAMING_SNAKE_CASE

Tài liệu đề xuất event dạng `SPRINT_STARTED`, `COMMIT_READY`, `AGENT_DISPATCHED`
(SCREAMING_SNAKE_CASE) — xung đột trực tiếp với convention `domain.action` snake_case chữ
thường đã dùng xuyên suốt `core/event.schema.json` từ Sprint 0 (`file.modified`,
`sessions.start`, `agents.error`, `verification.test_completed`, `review.started`,
`review.requested`...). **Quyết định: giữ nguyên convention cũ.** Khi Workflow Engine
(Sprint 6) cần các event mới cho vòng đời Sprint/Commit (`SPRINT_STARTED`, `COMMIT_READY`,
`COMMIT_APPROVED`, `COMMIT_BLOCKED`, `NEXT_COMMIT_READY`, `SPRINT_COMPLETED` trong tài liệu
gốc), đặt tên theo đúng quy trình đã dùng ở NF-047b ("tên đã chốt trước khi code, không để
Builder tự đặt") — ví dụ domain `sprints.*`/`commits.*` nối tiếp domain đã có
(`tasks.*`, `agents.*`, `verification.*`), không phát minh casing mới.

**Lưu ý phát hiện thêm (không thuộc tài liệu này, ghi lại để không quên):** code đã build ở
NF-051 dùng domain **`agent.stream`** (số ít) trong khi NF-052 dùng **`agents.error`**/
**`agents.stopped`** (số nhiều) — bất nhất số ít/số nhiều ngay trong domain `agent(s)` đã có
sẵn. Cần rà lại khi Sprint 6/7 mở rộng domain này, không lặp lại lỗi tương tự cho domain mới.


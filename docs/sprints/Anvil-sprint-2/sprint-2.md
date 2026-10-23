# Sprint 2 — "Anvil" (Project State & Session)

> Tên mã: **Anvil** (Đe) — nền tảng cố định để rèn mọi thứ lên đó. Sprint này dựng "nền"
> Project State độc lập giữa các project, để mọi sprint sau (Agent Protocol trở đi) có chỗ
> đứng ổn định. Trích từ `SPRINT_PLAN.md`, kèm tài liệu tham khảo riêng `ARCHITECTURE_SPRINT2.md`.


**Mục tiêu:** chốt "Node quản lý trạng thái project thế nào" (mục 58.2) trước khi có Agent
Protocol (Sprint 3). Tài liệu tham khảo đầy đủ: `ARCHITECTURE_SPRINT2.md` (bản trích riêng
từ `ARCHITECTURE.md`, chỉ gồm mục 6/32/33/35/36/37/38/53/57/58/63.1/63.2 — không cần đọc
lại toàn bộ 65 mục gốc).

> **Sửa 1 sai lệch quan trọng so với bản Sprint 2 nháp trước đây:** `project/session.schema.json`,
> `project/project.schema.json`, `project/task.schema.json` **đã tồn tại** trong baseline từ
> commit `d755576` (xác nhận ở NF-013-CLOSE, Sprint 0) — Sprint 2 **review + update có mục
> tiêu**, không "tạo mới" như bảng nháp cũ từng ghi. Nhầm "tạo mới" thành ticket sẽ khiến
> Builder ghi đè lên file đã có, có nguy cơ mất nội dung baseline.

### Bảng phụ thuộc trong-sprint

```
NF-001, NF-013-CLOSE (Sprint 0, đã Done)
   │
   ├─▶ NF-039 (review baseline project/session/task.schema.json vs thiết kế Sprint 2)
   │        │
   │        ▼
   │      NF-040 (thêm field commit_id vào task.schema.json)
   │
   ├─▶ NF-041 (Project Registry: project_id, lookup)
   │        │
   │        ▼
   │      NF-042 (Project isolation: state độc lập multi-project)
   │
   ├─▶ NF-043 (.forge/ layout đầy đủ — mở rộng ensureRuntimeDir từ NF-017 Sprint 1)
   │
   └─▶ NF-044 (Session module thật: link Agent+File, lưu SQLite — cần NF-039 + NF-017)
            │
            ▼
   NF-042 + NF-043 + NF-044 hội tụ ──▶ NF-045 (multi-project isolation test, exit criteria)
            │
            ▼
          NF-046 (exit check tổng hợp Sprint 2)
```

### Backlog

| ID | Ticket | Thư mục | Phụ thuộc | Est. | Acceptance criteria | Trạng thái |
|---|---|---|---|---|---|---|
| NF-039 | Review baseline `project/session.schema.json`, `project/project.schema.json`, `project/task.schema.json` (đã có từ commit `d755576`) đối chiếu thiết kế Sprint 2: `task.status` phải là enum cố định (`pending/active/blocked/completed/failed/cancelled`), tách biệt `task.workflow_state` (string tự do khớp `workflow.states` của `task.workflow_id`) — README v1.2, mục "Task.status vs Workflow.states". Không sửa file nếu đã đúng, chỉ báo cáo gap nếu có | `schemas/project/` (review only) | NF-013-CLOSE | S | Báo cáo dứt khoát: baseline đã đúng thiết kế hay có gap cụ thể (field nào, sai gì) — không trả lời chung chung "ổn" | Chưa bắt đầu |
| NF-040 | Thêm field optional `commit_id` vào `project/task.schema.json` (trỏ ngược Commit đã dispatch task đó — ARCHITECTURE mục 63.1, xem `ARCHITECTURE_SPRINT2.md`). Task **không** tự có `status` runtime riêng ngoài field đã có — chỉ thêm đúng 1 field tham chiếu | `schemas/project/task.schema.json` | NF-039 | S | `commit_id` optional (không bắt buộc — task tạo ngoài luồng Commit Dispatcher vẫn hợp lệ); fixture có/không có `commit_id` đều validate qua ajv; `validate:schemas` vẫn xanh, số schema không đổi (chỉ sửa field, không thêm file) | Chưa bắt đầu |
| NF-041 | Project Registry: sinh `project_id` ổn định, lookup theo path/id (mục 35/36, `ARCHITECTURE_SPRINT2.md`) | `src/modules/projects/` | NF-001 | M | 2 project khác path → 2 `project_id` khác nhau, ổn định qua nhiều lần mở lại (không sinh lại mỗi lần) | Chưa bắt đầu |
| NF-042 | Project isolation: state của N project mở song song hoàn toàn độc lập — không đọc/ghi nhầm `.forge/runtime/` của project khác (mục 57) | `src/modules/projects/` | NF-041 | M | Mở 2 project, sửa file ở project A → chỉ `index.db` của A cập nhật, B không đổi | Chưa bắt đầu |
| NF-043 | `.forge/` layout đầy đủ khi mở project lần đầu: mở rộng `ensureRuntimeDir()` (đã có từ NF-017, Sprint 1) thành `schemas/ rules/ workflows/ roadmap/ runtime/` (mục 53, `ARCHITECTURE_SPRINT2.md`). `rules/`+`workflows/` copy default từ root repo (STRUCTURE.md: "Committed default Node policy/rulesets") vào `.forge/rules/`, `.forge/workflows/` của từng project — không tạo rỗng | `src/infrastructure/` | NF-017 (Sprint 1, Done) | M | Mở project mới → đủ 5 thư mục con `.forge/`; `.forge/rules/`+`.forge/workflows/` có nội dung copy từ default, không rỗng; `.forge/runtime/` vẫn đúng hành vi cũ (index.db hoạt động, không đổi behavior NF-017/022/038) | Chưa bắt đầu |
| NF-044 | Session module thật: liên kết Agent↔File theo `session_id` (mục 32), lưu trạng thái session vào SQLite (mục 33, tái dùng `node:sqlite` adapter từ NF-017) — dùng schema `project/session.schema.json` đã review ở NF-039 | `src/modules/projects/` (hoặc module session riêng nếu cần) | NF-039, NF-017 | M | Tạo 1 session → có `session_id` ổn định; session liên kết đúng Agent + tập file đang thao tác; đóng session → dữ liệu vẫn còn trong SQLite (không mất khi restart) | Chưa bắt đầu |
| NF-045 | Integration test: multi-project isolation (exit criteria gốc) | `tests/integration/` | NF-042, NF-043, NF-044 | S | Mở 2 project song song thật (không mock) → state không lẫn nhau; `.forge/runtime/` mỗi project riêng biệt, gitignore; `rules/`+`workflows/`+`roadmap/` được commit như config (không bị ignore) | Chưa bắt đầu |
| NF-046 | Exit check Sprint 2: tổng hợp toàn bộ | Tất cả trên | — | S | `npm test` xanh 100%, `npm run lint`, `npm run typecheck`, `npm run validate:schemas`, `npm run bootstrap:smoke`, `git diff --check` đều xanh — đúng format Sprint 1 Gate đã dùng | Chưa bắt đầu |

**Ước tính:** S=nhỏ, M=vừa, L=lớn.

### Rủi ro cần lưu ý

| Rủi ro | Ảnh hưởng | Hướng xử lý đề xuất |
|---|---|---|
| NF-039 tưởng baseline "chắc đã đúng" rồi bỏ qua review thật | Gap ẩn trong `task.status`/`workflow_state` chỉ lộ ra ở Sprint 6 (Workflow Engine), sửa muộn tốn kém hơn | Bắt buộc NF-039 phải có báo cáo dứt khoát, không suy đoán — đúng nguyên tắc đã áp dụng suốt Sprint 0/1 |
| NF-043 ghi đè `.forge/runtime/` đang hoạt động từ Sprint 1 | Phá vỡ `forge watch`/`forge index rebuild` đã Done | NF-043 chỉ **mở rộng** `ensureRuntimeDir()`, không viết lại — test phải xác nhận NF-017/022/038 vẫn hoạt động sau khi thêm 4 thư mục con mới |
| Copy default `rules/`/`workflows/` từ root vào mỗi `.forge/` — nếu root default sau này đổi, các project cũ không tự đồng bộ | Config lệch dần giữa các project theo thời gian | Chấp nhận ở Sprint 2 (đây là bản chất "copy lúc khởi tạo", không phải symlink) — nếu cần đồng bộ lại, đó là tính năng riêng (`forge rules sync` chẳng hạn), không thuộc Sprint 2 |

### Exit criteria

- [ ] NF-045: mở 2 project song song, state không lẫn nhau
- [ ] `.forge/runtime/` gitignore; `rules/`+`workflows/`+`roadmap/` commit như config
- [ ] NF-046 tổng hợp: toàn bộ gate xanh

---

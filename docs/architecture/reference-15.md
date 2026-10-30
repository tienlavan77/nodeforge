<!-- Preserves original architecture reference lines 2558–2738 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
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

## 63.3. `roadmap/commit.schema.json`

> **Cập nhật sau review NF-028/033:** bản đầu để `verification.levels` inline enum trực tiếp
> — trùng lặp enum với `verification-plan.schema.json` (vi phạm "một enum, không nhân đôi").
> Sửa: `items` của `verification.levels` giờ `$ref` tới `$defs/verification_level` đã tách ra
> ở `verification-plan.schema.json` (mục 62.2) — tái dùng ở **cấp item**, không phải `$ref`
> nguyên field `#/properties/levels` (sẽ gây lỗi mảng lồng mảng). `uniqueItems: true` áp dụng
> đồng nhất cho cả `verification.levels` và `dependencies` (không chỉ 1 trong 2).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/roadmap/commit.schema.json",
  "title": "Commit",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "order", "objective", "acceptance_criteria"],
  "properties": {
    "id": { "type": "string" },
    "order": { "type": "integer", "minimum": 1 },
    "objective": { "type": "string", "minLength": 1 },
    "allowed_change_areas": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Glob path — khớp cơ chế role × path glob của project/permission.schema.json (README, mục Filesystem/Permission/Rule), không định nghĩa lại ACL riêng ở đây."
    },
    "acceptance_criteria": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1
    },
    "verification": {
      "type": "object",
      "additionalProperties": false,
      "required": ["levels"],
      "properties": {
        "levels": {
          "type": "array",
          "items": { "$ref": "https://forge.dev/schemas/verification/verification-plan.schema.json#/$defs/verification_level" },
          "minItems": 1,
          "uniqueItems": true
        }
      }
    },
    "dependencies": {
      "type": "array",
      "items": { "type": "string" },
      "uniqueItems": true,
      "description": "Danh sách commit_id phải hoàn tất trước."
    }
  }
}
```

Ghi chú: `verification.levels` ở đây chỉ là **khai báo cấp kế hoạch** ("commit này cần verify
tới mức nào") — khi Commit Dispatcher giao việc, Node dùng giá trị này để sinh
`verification-plan.schema.json` thật (mục 62.2) cho Task tương ứng, không phải bản thân
`verification-plan`.

## 63.4. `roadmap/sprint.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/roadmap/sprint.schema.json",
  "title": "Sprint",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "objective", "commits"],
  "properties": {
    "id": { "type": "string" },
    "objective": { "type": "string", "minLength": 1 },
    "dependencies": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Danh sách sprint_id phải hoàn tất trước."
    },
    "commits": {
      "type": "array",
      "items": { "$ref": "https://forge.dev/schemas/roadmap/commit.schema.json" },
      "minItems": 1
    }
  }
}
```

## 63.5. `roadmap/roadmap.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/roadmap/roadmap.schema.json",
  "title": "Roadmap",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "roadmap_id", "project_id", "version", "sprints"],
  "properties": {
    "schema_version": { "type": "string", "const": "1.0" },
    "roadmap_id": { "type": "string" },
    "project_id": { "type": "string" },
    "version": { "type": "string" },
    "goals": {
      "type": "array",
      "items": { "type": "string" }
    },
    "sprints": {
      "type": "array",
      "items": { "$ref": "https://forge.dev/schemas/roadmap/sprint.schema.json" },
      "minItems": 1
    },
    "constraints": {
      "type": "array",
      "items": { "type": "string" }
    }
  }
}
```


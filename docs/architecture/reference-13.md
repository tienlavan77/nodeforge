<!-- Preserves original architecture reference lines 2175–2360 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
# 61. Tóm tắt cực ngắn

```text
FORGE
│
├── NODE.JS
│   ├── Orchestrator
│   ├── Watcher
│   ├── Code Index
│   ├── Test Runner
│   ├── Context Engine
│   ├── Rule Engine
│   ├── Workflow Engine
│   ├── History/Event Store
│   ├── Project State
│   └── Agent Stream
│
├── BUILDER
│   └── trực tiếp đọc/ghi project
│
├── REVIEWER
│   └── review diff + verification + rules
│
├── PROJECT
│   ├── source
│   ├── tests
│   ├── config
│   └── .forge/
│
└── UI
    └── hiển thị state/event/stream
```

> **Agent không bị Node khóa filesystem. Node chỉ quan sát và điều phối.**
>
> **History và Code Index nằm trong `.forge/` của chính project.**
>
> **Rules, Workflow, Context, Event và Result đều có schema.**
>
> **Node chạy verification chính thức.**
>
> **AI chỉ nhận context cần thiết, không nhận toàn bộ project/history.**

---

# 62. Verification Engine — schema hoá pipeline verification

Bổ sung vào mục 55 (nguyên tắc source of truth): kết quả verification không được để
Builder tự claim. Nếu Node đảm nhiệm verification để tiết kiệm token (mục 47), quy trình
đó phải là một **contract có schema**, không phải logic rải rác trong code.

## 62.1. Quan hệ với `results/` đã có (README v1.2) — không phá nguyên tắc "gộp thay vì tách"

README v1.2 cố tình gộp build/lint/typecheck vào **1 file**
`results/check-result.schema.json` (field `kind` phân biệt), tách riêng
`results/test-result.schema.json` cho test. Đây vẫn là schema mô tả **hình dạng của 1 lần
chạy check** — không đổi.

5 schema verification mới ở dưới là một **tầng khác**: tầng *orchestration/gate*, trả lời
"phải chạy gì, đã chạy gì, kết quả tổng hợp có đủ điều kiện review chưa" — không mô tả lại
hình dạng của check. Để không lặp field, `verification-run.schema.json` **không** nhúng lại
toàn bộ nội dung `test-result`/`check-result`; nó chỉ giữ `result_ref` (id) trỏ tới record
`test-result`/`check-result` đã có sẵn trong `results/`. Vậy nguyên tắc "một enum/một shape,
không nhân đôi" của README vẫn giữ nguyên.

```
schemas/
├── results/                          # hình dạng 1 lần chạy check (đã có, README v1.2)
│   ├── test-result.schema.json
│   ├── check-result.schema.json
│   └── review-result.schema.json
│
└── verification/                     # tầng orchestration/gate (mới)
    ├── verification-plan.schema.json
    ├── verification-run.schema.json   # $ref tới results/ qua result_ref, không nhúng lại
    ├── verification-result.schema.json
    ├── test-failure.schema.json
    └── verification-policy.schema.json
```

## 62.2. `verification/verification-plan.schema.json`

Mô tả 1 commit cần kiểm tra những gì. Node đọc để biết phải chạy gì.

> **Cập nhật sau review NF-028:** bản đầu để `levels`/`checks[].type` là enum inline. Builder
> chỉ ra lỗ hổng khi `roadmap/commit.schema.json` (mục 63.3) cần tái dùng enum `levels` ở
> **cấp item** (mỗi phần tử trong mảng `verification.levels` của Commit) — nếu `$ref` thẳng
> tới `#/properties/levels` (nguyên cả field, vốn đã là 1 mảng), item sẽ bị ép phải là mảng
> lồng mảng, sai. Sửa bằng cách tách 2 giá trị dùng lại thành `$defs` cấp-giá-trị-đơn
> (`verification_level`, `check_type`), đúng nguyên tắc "một enum, không nhân đôi" (README
> v1.2) — các nơi khác `$ref` tới `$defs` này ở cấp item, không tới `properties.levels` nguyên
> field nữa.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/verification/verification-plan.schema.json",
  "title": "VerificationPlan",
  "description": "The checks Node must run for a commit. This is orchestration metadata, not an individual check result.",
  "type": "object",
  "additionalProperties": false,
  "required": ["commit_id", "levels", "checks"],
  "$defs": {
    "verification_level": {
      "type": "string",
      "enum": ["focused", "related", "full"]
    },
    "check_type": {
      "type": "string",
      "enum": ["test", "lint", "typecheck", "build"]
    }
  },
  "properties": {
    "schema_version": { "type": "string", "const": "1.0" },
    "commit_id": { "type": "string" },
    "levels": {
      "type": "array",
      "items": { "$ref": "#/$defs/verification_level" },
      "minItems": 1,
      "uniqueItems": true
    },
    "checks": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["type", "command"],
        "properties": {
          "type": { "$ref": "#/$defs/check_type" },
          "command": { "type": "string", "minLength": 1 },
          "timeout_ms": { "type": "integer", "minimum": 0 }
        }
      }
    }
  }
}
```

> `title` giữ nguyên `"VerificationPlan"` (PascalCase, không prefix) để nhất quán với 7 schema
> còn lại trong `verification/`+`roadmap/` — nếu Builder cần đổi convention đặt tên, áp dụng
> đồng loạt cho cả 8 file trong 1 ticket riêng, không đổi lẻ tẻ từng file.

## 62.3. `verification/verification-run.schema.json`

Mỗi lần Node thực sự chạy verification. Hữu ích cho history/audit; mỗi phần tử `checks`
chỉ giữ `result_ref` trỏ tới `test-result`/`check-result` thật, không nhúng lại nội dung.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/verification/verification-run.schema.json",
  "title": "VerificationRun",
  "type": "object",
  "additionalProperties": false,
  "required": ["run_id", "commit_id", "level", "started_at", "checks", "status"],
  "properties": {
    "run_id": { "type": "string" },
    "commit_id": { "type": "string" },
    "level": { "enum": ["focused", "related", "full"] },
    "started_at": { "type": "string", "format": "date-time" },
    "completed_at": { "type": "string", "format": "date-time" },
    "status": { "enum": ["passed", "failed", "error", "running"] },
    "checks": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["type", "command", "status"],
        "properties": {
          "type": { "enum": ["test", "lint", "typecheck", "build"] },
          "command": { "type": "string" },
          "status": { "enum": ["passed", "failed", "error", "skipped"] },
          "exit_code": { "type": "integer" },
          "duration_ms": { "type": "integer", "minimum": 0 },
          "result_ref": {
            "type": "string",
            "description": "ID của record trong results/test-result.schema.json hoặc results/check-result.schema.json — KHÔNG nhúng lại nội dung ở đây."
          }
        }
      }
    }
  }
}
```


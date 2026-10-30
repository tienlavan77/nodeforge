<!-- Preserves original architecture reference lines 2361–2557 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
## 62.4. `verification/verification-result.schema.json`

Kết quả chính thức Node đưa vào Workflow Engine — đây là schema duy nhất mà Workflow Engine
cần đọc, không cần biết chi tiết từng check.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/verification/verification-result.schema.json",
  "title": "VerificationResult",
  "type": "object",
  "additionalProperties": false,
  "required": ["commit_id", "run_id", "status", "ready_for_review"],
  "$defs": {
    "gate_status": { "enum": ["passed", "failed", "skipped", "not_applicable"] }
  },
  "properties": {
    "commit_id": { "type": "string" },
    "run_id": { "type": "string" },
    "evaluated_at": { "type": "string", "format": "date-time" },
    "status": { "$ref": "#/$defs/gate_status" },
    "scope": { "$ref": "#/$defs/gate_status" },
    "rules": { "$ref": "#/$defs/gate_status" },
    "tests": { "$ref": "#/$defs/gate_status" },
    "lint": { "$ref": "#/$defs/gate_status" },
    "typecheck": { "$ref": "#/$defs/gate_status" },
    "build": { "$ref": "#/$defs/gate_status" },
    "ready_for_review": { "type": "boolean" }
  }
}
```

```text
verification.status == passed
             +
        rules == passed
             +
        scope == passed
             ↓
      READY_FOR_REVIEW
```

## 62.5. `verification/test-failure.schema.json`

Cơ chế giảm token quan trọng nhất của tầng này: Node không gửi log thô cho Builder, chỉ
gửi bằng chứng tối thiểu đã chuẩn hoá.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/verification/test-failure.schema.json",
  "title": "TestFailure",
  "type": "object",
  "additionalProperties": false,
  "required": ["test_result_id", "test", "file", "message"],
  "properties": {
    "test_result_id": {
      "type": "string",
      "description": "ID record test-result mà failure này trích ra."
    },
    "test": { "type": "string" },
    "file": { "type": "string" },
    "line": { "type": "integer", "minimum": 1 },
    "column": { "type": "integer", "minimum": 1 },
    "error": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "type": { "enum": ["assertion", "exception", "timeout", "other"] },
        "expected": {},
        "actual": {}
      }
    },
    "message": { "type": "string", "maxLength": 500 },
    "stack_excerpt": {
      "type": "string",
      "maxLength": 500,
      "description": "Tối đa vài dòng đầu của stack trace, không phải log đầy đủ."
    }
  }
}
```

```text
10,000 lines raw log
        ↓
       Node
        ↓
   normalize (test-failure.schema.json)
        ↓
    ~200 bytes / failure
        ↓
     Builder
```

`message` và `stack_excerpt` giới hạn cứng độ dài (`maxLength`) ngay ở tầng schema — đây là
cách ép nguyên tắc "context nhỏ nhất nhưng đủ suy luận" (README, mục Context compression)
không phụ thuộc vào việc Context Engine có nhớ cắt bớt hay không.

## 62.6. `verification/verification-policy.schema.json`

Rule cho chính Verification Engine — Node không tự quyết định tuỳ tiện `stop_on_failure`
hay số lần retry.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/verification/verification-policy.schema.json",
  "title": "VerificationPolicy",
  "type": "object",
  "additionalProperties": false,
  "required": ["focused", "related", "full", "max_retries"],
  "$defs": {
    "level_policy": {
      "type": "object",
      "additionalProperties": false,
      "required": ["required", "stop_on_failure"],
      "properties": {
        "required": { "type": "boolean" },
        "stop_on_failure": { "type": "boolean" }
      }
    }
  },
  "properties": {
    "focused": { "$ref": "#/$defs/level_policy" },
    "related": { "$ref": "#/$defs/level_policy" },
    "full": { "$ref": "#/$defs/level_policy" },
    "max_retries": { "type": "integer", "minimum": 0 }
  }
}
```

**Vì sao không dùng `project/rule.schema.json` sẵn có cho việc này:** Rule (README) trả lời
*"thay đổi này có tốt/tuân thủ không"* — đối tượng đánh giá là **code**. Verification Policy
trả lời *"chính Verification Engine phải hành xử thế nào khi 1 check fail"* — đối tượng
cấu hình là **hành vi của Node**, không phải code. Hai schema có đối tượng áp dụng khác
nhau nên tách riêng; nếu sau này cần logic phức tạp hơn (`condition`/`condition_language`),
có thể tái dùng cơ chế đó từ `rule.schema.json` thay vì phát minh lại — nhưng ở v1,
`verification-policy` giữ dạng cấu hình đơn giản.

## 62.7. Pipeline tổng thể

```text
                 COMMIT TASK
                     │
                     ▼
             Verification Plan
                     │
                     ▼
              ┌──────────────┐
              │ NODE RUNNER  │
              └──────┬───────┘
                     │
              ┌──────┴──────┐
              ▼             ▼
           command        scope/rule
              │             │
              ▼             ▼
          raw output     check result (results/*)
              │
              ▼
        Result Normalizer
              │
        ┌─────┴─────┐
        ▼           ▼
      PASS         FAIL
        │           │
        │           ▼
        │      Failure Extractor (test-failure.schema.json)
        │           │
        │           ▼
        │        BUILDER
        │
        ▼
 verification-result.schema.json
        │
        ▼
 READY_FOR_REVIEW
        │
        ▼
    REVIEWER
```

**Nguyên tắc bổ sung vào mục 55/60:**

> Node là nguồn sự thật cho verification result. Builder có thể chạy test để hỗ trợ quá
> trình phát triển, nhưng "Builder nói tests pass" không có nghĩa Forge ghi nhận PASS —
> phải là Node executed → exit code → normalized result → `verification-result` →
> workflow gate.

---

# 63. Roadmap → Sprint → Commit — schema hoá kế hoạch cấp cao

Roadmap là tầng **cao hơn** Task: `Roadmap → Sprint → Commit → Builder → Verify → Reviewer`.
Mỗi tầng cần contract riêng, tương tự cách Task/Workflow đã có schema ở README v1.2.


<!-- Lưu snapshot checksum và bản trích tool response P1 để truy vết verification/Git; không thay thế receipt runtime hay decision có xác thực. -->
# Evidence P1 — snapshot và tool responses

Ngày lập: 2026-10-12. Đây là bản trích do System Engineer ghi từ tool responses trong hội thoại, không phải export độc lập của Node receipt/decision store.

## A1 — Provenance ủy quyền

- Nội dung owner trong hội thoại, nguyên văn: `đồng ý triển khai trực tiếp P1`.
- Ngữ cảnh: trả lời câu hỏi cho phép triển khai P1 trực tiếp, không qua Sprint Plan.
- Phạm vi: chung policy/implementation SE+AM, hai root và lease riêng; không migration/cleanup/mở quyền Coder.
- Message ID, decision ID, authenticated actor ID và timestamp chính xác của message: **chưa lấy được**. Ngày hội thoại: 2026-10-12; không dùng timestamp verification thay cho thời điểm ủy quyền.
- Conversation scope trong verification tool: `59c84fe0-a3bf-4de9-9d5d-2e3a2730db28` (suy từ `commit_id` theo `ownerRunId` tại `backend/src/tools/owner-engineer-tools.js:91`). Đây **không phải** message/decision ID.
- Không có xác nhận exact approval cho plan nguồn; ủy quyền trực tiếp và approval plan là hai loại bằng chứng khác nhau.

## S1 — Snapshot code quan sát trước E2

Forge `read_file` trả các whole-file SHA-256 dưới đây trước run E2; không sửa source trong lượt bổ sung báo cáo. Các hash trùng kết quả Forge writes của lượt triển khai P1 có trong hội thoại. Git status trước run sạch. Đây là liên kết quan sát local snapshot → run, **không** phải signed source attestation, Git tree hash hoặc chứng minh độc lập nội dung commit/remote.

| Path | SHA-256 (không gồm tiền tố `sha256:`) | Dòng |
| --- | --- | --- |
| `backend/scripts/control-api-http.mjs` | `afdb2bdd217b01d34fa825020d76b5f8d1fcb522970ef64558f0f2d9dff6387a` | 83 |
| `backend/src/application/owner-execution-checkpoint.js` | `fee1ddcc15e3dfdf36e164a79aab371f6750080fcc30f64ee7549a963afadf1f` | 234 |
| `backend/src/application/owner-execution-checkpoint.md` | `aaa300add7b5bdacfd12ee8e98d6bc66181f575872ee7bd2684bd7a4ef097209` | 37 |
| `backend/src/application/owner-execution-control.js` | `dd9e1566b97475098fec8a5556a7b125e2cc0041a78e73d09af6697da2ca8f67` | 91 |
| `backend/src/application/owner-execution-record-guards.js` | `6fd7db987586a45aa1a44f6f9022714a269654d041fbd0c493eb37ccc8f500a2` | 19 |
| `backend/src/application/owner-execution-role-policy.js` | `ebfbd6542f67e24b9e46a44c3a8b87a38e34bb7e3b6ad8f4aaff6c2fd45a5353` | 20 |
| `backend/src/application/owner-sdk-stream.js` | `43e7433c22df95ce297c9703341eb0ca0802534e60f944f1d582dc094620f732` | 187 |
| `backend/tests/unit/architecture-execution.test.js` | `f96a31bf05a9d4e3bed7f9de66027ae13342cd9170d56d9a687fd6d005b176c8` | 167 |
| `backend/tests/unit/owner-builtin-tools.test.js` | `118487380db89177929122fc460388dfe1ea69dfee82d02d66e04899d72db847` | 159 |
| `backend/tests/unit/owner-execution-checkpoint.test.js` | `e7fbb7758135d27d21d9c58c5e953eca5f5b755b931caa7dd7be4302eaf403fd` | 212 |
| `backend/tests/unit/owner-execution-role-policy.test.js` | `87d652c1a65574f0174db58063a55a520ab3ee93a242ce85d11c951dcfd08ad6` | 175 |

## E1 — Verification gốc (trích field từ tool response lượt triển khai)

- `run_id`: `VERIFY-RUN-a077b4cf-b387-4b93-8241-9dde1da9591a`.
- `commit_id`: `OWNER-59c84fe0-a3bf-4de9-9d5d-2e3a2730db28-CORR-system-engineer-a38f8a56-8f78-43c5-83b6-d306b97f67ac`.
- `evaluated_at`: `2026-10-12T04:54:46.841Z`; `status: passed`, exit `0`, scope `passed`.
- Command giống E2; `changed_paths` gồm 11 path trong S1.
- `commit_id` là owner-run key, **không phải Git SHA**. Run trước source commit; không có tree SHA/source manifest được Verification Service xác nhận trong response.
- Chưa đọc được artifact persisted của E1 độc lập với hội thoại.

## E2 — Verification lại trong lượt bổ sung (tool response đầy đủ)

```json
{
  "commit_id": "OWNER-59c84fe0-a3bf-4de9-9d5d-2e3a2730db28-CORR-system-engineer-5eaf87a4-4ce0-44b3-a7bd-60a694e998b3",
  "run_id": "VERIFY-RUN-a2ca20d9-4ba5-410d-be86-646e3f186f5f",
  "evaluated_at": "2026-10-12T05:19:30.054Z",
  "status": "passed",
  "ready_for_review": true,
  "breakdown": [
    {
      "kind": "test",
      "status": "passed",
      "command": "node --test backend/tests/unit/owner-execution-role-policy.test.js backend/tests/unit/owner-execution-checkpoint.test.js backend/tests/unit/architecture-execution.test.js backend/tests/unit/owner-builtin-tools.test.js",
      "exit_code": 0
    }
  ],
  "tests": "passed",
  "build": "not_applicable",
  "lint": "not_applicable",
  "typecheck": "not_applicable",
  "scope": "passed",
  "changed_paths": ["workflows/report-shared-owner-execution-checkpoint-p1.md"]
}
```

`changed_paths` là conversation change ledger, không phải danh sách source đã test hay source manifest. Liên kết S1 → E2 là snapshot quan sát trước run, không suy từ field này. Chưa có tổng số test case/TAP output trong response; không suy diễn số pass/fail. Không chạy full suite/lint/typecheck/build/browser E2E.

## G1 — Commit receipt (trích tool response lượt triển khai)

- Tool: `mcp__forge.commit_changes`.
- Message: `Share owner execution policy while preserving role-isolated checkpoints`.
- Returned `sha`: `52e9fc1e3bb6c3a369a2010840f670ad17d77ad2`.
- Output: `[ui-chat 52e9fc1] Share owner execution policy while preserving role-isolated checkpoints`; `11 files changed, 312 insertions(+), 46 deletions(-)`.
- Returned `paths`: đúng 11 path trong S1; không có `workflows/`.
- Chưa có timestamp/receipt ID độc lập hoặc Git object/tree export để đối chiếu snapshot S1 với SHA này.

## G2 — Push receipt (trích tool response lượt triển khai)

- Tool: `mcp__forge.push_commit`; input SHA bằng G1.
- Returned `sha`: `52e9fc1e3bb6c3a369a2010840f670ad17d77ad2`, `remote: origin`, `branch: ui-chat`.
- Returned output:

```text
To github.com-tienlavan77:tienlavan77/nodeforge.git
 	HEAD:refs/heads/ui-chat	ce7f9e8..52e9fc1
Done
```

Đây là receipt thành công tại thời điểm push trong hội thoại, **không phải remote HEAD hiện tại**; không coi `ce7f9e8` là full rollback SHA hoặc xác nhận parent commit.

## L1 — Giới hạn truy xuất độc lập

- Forge `search_tree` cho `.forge/runtime/owner-executions` trả `CONFIGURATION_ERROR: search_tree path must stay inside the project`; không vượt boundary này bằng SDK/shell hoặc sửa runtime.
- Các Forge Git tools được cấp chỉ có status/diff/commit/push; không có read-only remote HEAD, log/show hoặc receipt lookup. Không re-push chỉ để giả làm kiểm tra remote.
- Code `owner-engineer-tools.js:33` dùng owner-run key cho verification; `:46` ghi last-commit metadata vào conversation state. Đây là discovery về nơi quản lý metadata, không chứng minh đã đọc record runtime.
- Cần operator cung cấp export owner message/decision, verification artifact và commit/push receipt cùng read-only remote-ref evidence. Mọi export cần path/ID, checksum, timestamp và actor/source rõ ràng, không chứa secrets.

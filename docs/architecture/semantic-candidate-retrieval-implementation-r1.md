<!-- Records the approved retrieval implementation and the limits of its verification for owner and architecture review. -->
# Semantic and candidate retrieval — implementation r1

Người nhận: Owner và Architecture Manager; bằng chứng phục vụ Reviewer độc lập.

Kế hoạch: `PLAN-PROJECT-NODEFORGE-e23f47df-29a2-49c1-8f4d-6b545fcf191e r1`.
Nguồn: `.forge/runtime/nf/plans/PLAN-PROJECT-NODEFORGE-e23f47df-29a2-49c1-8f4d-6b545fcf191e/plan-source-r1.json`.
SHA-256 nguồn kế hoạch: `66a9ac6db7fd28095d0e43fa4e8382ff33b40e6a2d6ed2325f0d304de2450926`.

Thay đổi nằm trong working tree trên nhánh `ui-chat`, HEAD khi kiểm chứng:
`1a8d1932b53c9a65590abbf208a73d0b6943f8eb`.
Các receipt dưới đây kiểm tra working tree, không chứng minh HEAD đã chứa patch.
Chưa commit, push, triển khai hay chạy migration production.

## Kết quả triển khai

### O1 — receipt và evidence

- Cả candidate mới và `cachedTicketCandidates` đi qua cùng bước xác thực nguồn.
- Helper mới `backend/src/tools/discovery/candidate-source-receipts.js` kiểm tra quyền đường dẫn, đọc bytes qua File Service, tính SHA-256 thực tế, trích xuất lại symbol map và gọi đúng `recordSourceMetadata(context, metadata)`.
- Không tin SHA, symbol map hoặc trạng thái fresh do retrieval tự cung cấp. Candidate stale hoặc không xác thực được vẫn có thể được trả như gợi ý, với receipt unavailable; không cấp quyền đọc symbol từ metadata đó.
- Recheck grant quanh các bước bất đồng bộ và trước đăng ký; grant bị thu hồi không thể tạo receipt mới.
- Receipt và lưu evidence bền vững có trạng thái riêng. Lỗi có thông tin và log; không nuốt lỗi.
- `subagent-evidence-sync.js` chỉ lưu metadata gắn với object đã xác thực qua private WeakMap. Không giả lập subagent provenance, không đánh dấu symbol đã được đọc khi mới retrieval.
- Đồng bộ checksum đã xác thực về context, conversation state và ticket checkpoint/read cache. Reviewer giữ checksum qua lớp bọc SDK.
- Graph chưa có nguồn xác thực được gắn `index_status: unavailable`; graph rỗng không phải bằng chứng không có dependency.

### O2 — runtime và quyền

- Nối definition/implementation qua owner role policy, conversation registry, planning/explorer filter, SDK dependency injection, Coder capabilities và Reviewer registry.
- Coder Claude/Codex/OpenAI/Ollama có tool khi discovery được phép; `direct_code` và immutable baseline tiếp tục loại tool khỏi capability/definition tương ứng.
- Sender quảng bá candidate theo capability được cấp, bỏ điều kiện cấm toàn bộ Coder.
- Reviewer dùng nguồn review cố định/đã xác thực để cấp receipt; không dùng bytes từ live cache thay thế snapshot.
- ReviewWorker truyền selector và freshness checker xuống registry. Kiểm thử qua worker xác nhận candidate → receipt → Read(symbol) và checksum, ngoài kiểm thử registry.
- Điều chỉnh chính xác ràng buộc schema transport Claude bị Zod từ chối: bỏ bản lặp `not.required(path)` khi `additionalProperties:false` đã cấm thuộc tính path không khai báo. Validation phía Node và từ chối input mở rộng authority vẫn giữ.
- Prompt và README của AM/SE/Coder/RV/SL hướng dẫn dừng discovery không cần thiết theo freshness, symbolic read và coverage; vẫn cho tìm tiếp khi stale, thiếu coverage hoặc fallback có lý do.
- Grant v2 Coder hiện có quyền đọc dự án theo policy sẵn có; test giới hạn danh sách read paths dùng grant Reviewer. Không sửa chính sách v2 để phù hợp với giả định fixture sai.

## Bằng chứng kiểm chứng

### Acceptance tập trung — PASS

Run: `VERIFY-RUN-9631ab3a-354e-4d1f-9941-7d58aaa98fb7`; exit code 0.

```text
node --test backend/tests/tools/candidate-source-receipts.test.js backend/tests/tools/candidate-source-authority.test.js backend/tests/unit/candidate-runtime-access.test.js backend/tests/tools/select-code-graph-candidates.test.js backend/tests/tools/retrieval-governance.test.js backend/tests/unit/coder-unified-forge-tools.test.js backend/tests/unit/sender-worker-retrieval-tools.test.js backend/tests/unit/reviewer-forge-runtime-access.test.js backend/tests/unit/reviewer-candidate-worker.test.js backend/tests/unit/review-worker.test.js
```

10 file kiểm thử, gồm receipt live/cache, SHA/symbol giả, stale source, lỗi durability, payload evidence giả, scope/revocation, handoff AM → SE → RV, owner role registry, Coder Claude/Codex, sender và Reviewer worker/snapshot.
Receipt không trả tổng số test case; báo cáo không suy đoán số case.

### Transport OpenAI/Ollama — PASS

Run: `VERIFY-RUN-11e18d1b-5336-4d46-bfe5-56a21d890e0a`; exit code 0.

```text
node --test --test-name-pattern="exposes governed candidate retrieval only for mutable discovery" backend/tests/unit/function-calling-task-executor.test.js
```

Các case mới đi qua function tools của SDK bằng gateway giả: gọi candidate khi mutable, kiểm tra capability thực tế tại service và loại candidate trong direct_code.

### Kiểm chứng Reviewer riêng — PASS

Run: `VERIFY-RUN-8622b3ad-5b53-4322-a97d-f7d4aef3185f`; exit code 0.

```text
node --test backend/tests/unit/reviewer-candidate-worker.test.js backend/tests/unit/review-worker.test.js backend/tests/unit/candidate-runtime-access.test.js backend/tests/unit/reviewer-forge-runtime-access.test.js
```

### Các lượt FAIL và giới hạn

- `VERIFY-RUN-1e96bd74-4158-45fa-aebc-c9db09c9197f` và `VERIFY-RUN-e8c2ac97-a586-4a51-af53-7397f053f360`: hồi quy mở rộng ban đầu FAIL, gồm lỗi fixture đã sửa và các lỗi chưa xử lý bên dưới.
- `VERIFY-RUN-43691a8e-8b83-4d06-94a3-1e4f34c74ed4`: test mới giả định grant Coder bị giới hạn bởi read_paths; đã sửa fixture sang Reviewer đúng policy. Lượt acceptance cuối PASS.
- `VERIFY-RUN-bd1344c1-f3c5-4f5b-9459-d822b009b6a4`: phát hiện checksum Reviewer bị mất qua context clone và kỳ vọng Claude allowlist cũ; đã sửa và chạy lại PASS.
- Các bộ hồi quy rộng hơn chưa sạch: catalog fixture kỳ vọng `send_execution_directive` chưa được bind; cache test dùng API read_file với line arguments đã ngừng hỗ trợ; function-calling restriction fixture dùng service mock trả thành công trái kỳ vọng; một số Codex supervisor fixture thiếu hard-review worker (`REVIEW_WORKER_UNAVAILABLE`). Chưa tái hiện trên baseline cô lập, nên không coi đây là bằng chứng lỗi có sẵn hay tuyên bố toàn bộ hồi quy PASS.
- Hai yêu cầu ESLint qua run_check bị validator từ chối trước khi thực thi. Đã yêu cầu ESLint cho các file thay đổi qua Forge run_command với `timeout_ms:60000`; không nhận được kết quả cuối và đã ngừng chờ. Lint chưa xác minh.
- Không chạy full suite, build, migration, backfill hoặc phiên model thật. Kiểm thử handoff là fixture dùng source/evidence store và đối chiếu exact SHA-256, symbols, checksum, scope, freshness; không thay thế nghiệm thu production hay verdict của Reviewer độc lập.

## Đường dẫn bằng chứng và phạm vi thay đổi

Nguồn chính:

- `backend/src/tools/discovery/candidate-source-receipts.js`
- `backend/src/tools/discovery/select-code-graph-candidates.js`
- `backend/src/tools/discovery/subagent-evidence-sync.js`
- `backend/src/tools/engineering-tool-binding.js`
- `backend/src/tools/index.js`
- `backend/src/tools/roles/owner-conversation-tools.js`
- `backend/src/tools/roles/owner-role-tool-policy.js`
- `backend/src/tools/roles/owner-claude-mcp-tools.js`
- `backend/src/tools/roles/claude-sdk-forge-tools.js`
- `backend/src/application/owner-sdk-stream.js`
- `backend/scripts/control-api-http.mjs`
- `backend/src/modules/supervisor/nodeforge-task-executors.js`
- `backend/src/modules/supervisor/function-calling-task-executor.js`
- `backend/src/modules/supervisor/nodeforge-task-integration.js`
- `backend/src/modules/supervisor/nodeforge-task-prompts.js`
- `backend/src/modules/supervisor/production-runtime.js`
- `backend/src/modules/supervisor/sender-worker.js`
- `backend/src/modules/supervisor/ticket/ticket-resume.js`
- `backend/src/modules/supervisor/review/review-worker.js`
- `backend/src/modules/supervisor/review/reviewer-forge-tools.js`

Test mới:

- `backend/tests/tools/candidate-source-receipts.test.js`
- `backend/tests/tools/candidate-source-authority.test.js`
- `backend/tests/unit/candidate-runtime-access.test.js`
- `backend/tests/unit/reviewer-candidate-worker.test.js`

Test cập nhật: `coder-unified-forge-tools`, `function-calling-task-executor`, `review-worker`, `engineering-tool-catalog`, `codex-sdk-supervisor-forge-mcp` trong `backend/tests/unit`.
Hướng dẫn cập nhật: `workflows/agents/{architecture,system-engineer,coder,reviewer,sprint-leader}/README.md`.

Đã xem git_status và scoped git_diff. Workspace có thay đổi staged/unstaged từ trước; không reset, commit hay quy toàn bộ diff cho kế hoạch này.
Tái sử dụng source metadata fresh từ durable evidence của parent SE (`parent:885b2b5f-5247-4dfc-8f05-968de25391dc`) và graph metadata do Forge cấp.

Còn lại trước nghiệm thu production: hoàn tất lint, phân loại/khắc phục các hồi quy rộng hơn trong phạm vi phù hợp, và review độc lập trên patch/commit được chọn.

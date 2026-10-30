<!-- Preserves an ordered historical design section so repository restructuring retains the full technical discussion and can verify its original checksum after splitting. -->
- supervisor contract,
- stream event.

Các quyết định schema tốt:

- core event/command là nguồn enum trung tâm;
- `task.status` tách khỏi `workflow_state`;
- permission và rule là hai lớp khác nhau;
- verification result là workflow gate chính thức;
- roadmap/sprint/commit là planning layer, task là runtime;
- context pack có `index_version` và `generated_at`;
- secret không được vào context.

Các fixture cần kiểm tra lại:

```text
schemas/examples/agent-profile-devquote-builder.json
schemas/examples/agent-profile-devquote-reviewer.json
schemas/examples/governance-agent-profile.json
```

Có khả năng còn fixture dùng status `configured`, `not connect`, thiếu `role`, provider cũ hoặc legacy agent ID.

## 15. Rules và workflows

Workflow chính:

```text
workflows/forge-sprint-delivery.workflow.json
```

Schema tương ứng:

```text
schemas/project/workflow.schema.json
schemas/project/workflow-rule.schema.json
schemas/project/workflow-ruleset.schema.json
```

Tài liệu schema quy định ruleset mặc định:

```text
rules/forge-sprint-delivery.rules.json
```

Nhưng full test trước đó báo thiếu file này. Đây là contract/data gap rõ ràng: workflow definition có nhưng ruleset mặc định có thể bị thiếu, bị ignore hoặc code/test đang trỏ sai path.

Planning hierarchy:

```text
Roadmap → Sprint → Commit → Runtime Task
```

## 16. Agent tools và retrieval governance

Tools:

```text
backend/src/tools/
├── read-code.js
├── read-transcript-blocks.js
├── search-code.js
├── select-code-graph-candidates.js
├── retrieval-governance.js
├── tool-authorization.js
└── index.js
```

Mục tiêu:

- đọc đúng context cần thiết,
- giới hạn path và secret,
- authorization tool,
- chọn file/symbol qua code graph,
- đọc transcript có governance.

Tests tương ứng đã có trong `backend/tests/tools/`.

Một script test `search_code` từng fail vì agent không phát tool call mà test chờ đợi. Cần phân biệt test Node deterministic với test phụ thuộc provider/agent bên ngoài.

## 17. Security và governance

Các lớp bảo vệ đã có:

```text
protected-path-policy.js
secret-paths.js
persistent-secret-backend.js
tool-authorization.js
atomic-apply-gate.js
concurrent-modification-detector.js
```

Nguyên tắc đang được áp dụng:

- profile chỉ lưu `credential_ref`, không lưu plaintext API key;
- API response mask key bằng `********`;
- secret path bị loại khỏi context;
- agent không được tự ý sửa `.forge/`;
- patch phải qua validation/checksum;
- queue có idempotency và process lock;
- recovery tránh request trùng;
- Node kiểm tra quyền trước các thao tác được governance kiểm soát.

Do nhiều file security/policy đang modified hoặc untracked, cần chạy security review độc lập sau khi baseline được ổn định.

## 18. Kết quả kiểm tra đã thực hiện

### Live API

Control API đang chạy bằng:

```text
node backend/scripts/start-control-api.mjs
```

Port:

```text
3100
```

Đã xác nhận:

```http
GET  /forge/v1/agents
GET  /forge/v1/agents/:uuid
POST /forge/v1/agents/:uuid/test
```

Connection test trả `CONNECTED` qua local và LAN.

### Syntax

Các file chính đã qua `node --check`:

```text
backend/src/application/agent-settings-service.js
backend/src/modules/agent/agent-profile-store.js
backend/src/transport/http/forge-v1-router.js
backend/src/transport/http/server.js
```

### Full test

Kết quả đã quan sát:

```text
222 tests total
210 passed
12 failed
```

Các failure chính:

1. Thiếu `rules/forge-sprint-delivery.rules.json`.
2. Test còn trỏ frontend path cũ:
   - `backend/web/src/main.jsx`
   - `backend/web/src/services/node-client.js`
   - `backend/web/src/services/ticket-result-summary.js`
3. Test tool `search_code` không nhận được tool call kỳ vọng.

Các failure này chưa chứng minh lỗi ở UUID agent route; route live đã pass độc lập.

### Diff hygiene

`git diff --check` đã phát hiện blank line cuối file tại:

```text
backend/src/application/agent-settings-service.js
backend/src/modules/agent/provider-adapters/devquote-adapter.js
schemas/governance/agent-profile.schema.json
```

## 19. Đánh giá theo trạng thái

### Đã có nền tảng tốt

- Kiến trúc orchestrator multi-agent.
- Supervisor theo task.
- Durable queue và recovery.
- Sender/materializer/verification/repair pipeline.
- Event store, history và unified stream.
- Filesystem watcher và code index.
- Context selection/retrieval governance.
- Protocol storage và round state.
- Agent gateway và provider adapters.
- Agent profile persistence.
- UUID migration trong live database.
- Forge v1 agent CRUD.

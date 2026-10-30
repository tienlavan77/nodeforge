<!-- Preserves an ordered historical design section so repository restructuring retains the full technical discussion and can verify its original checksum after splitting. -->
backend/src/infrastructure/sqlite/database-service.js
backend/src/infrastructure/sqlite/index-database.js
backend/src/infrastructure/storage/protocol-storage.js
```

Runtime state nằm trong `.forge/runtime/`. Database live đã được xác định là:

```text
.forge/runtime/nf/index.db
```

Các path khác tồn tại nhưng không phải database agent live đã xác nhận:

```text
backend/.forge/runtime/nf/index.db
.forge/runtime/index.db
```

Khi debug API/database phải xác nhận process đang chạy với đúng `cwd`, `dataDir` và database path; chạy process từ working directory khác có thể tạo cảm giác dữ liệu hoặc route không khớp.

Protocol state theo round gồm:

```text
round_N/request.json
round_N/request.meta.json
round_N/response.json
round_N/response.meta.json
round_N/state.json
```

Các identity phải được giữ riêng:

- `task_id`: identity của task/ticket.
- `conversation_id`: hội thoại agent-task.
- `request_id`: một request cụ thể.
- `provider_response_id`: identity do provider cấp.

NodeForge không được dùng `provider_response_id` thay cho `task_id` hoặc `request_id`.

## 6. Agent subsystem

Hai khu vực agent hiện tồn tại:

```text
backend/src/modules/agent/
backend/src/modules/agents/
```

`modules/agent` chủ yếu chứa profile, gateway, provider adapter, runtime và request/response. `modules/agents` chứa external process protocol, session link, stream bridge, idempotency và context-read handler. Hai khu vực có vai trò khác nhau nhưng tên gần nhau, cần được giữ boundary rõ ràng hoặc tài liệu hóa thêm trước khi refactor.

Các thành phần quan trọng:

```text
agent-profile-store.js
agent-gateway.js
agent-runtime.js
agent-registry.js
agent-request-builder.js
agent-result-router.js
agent-transcript-store.js
node-agent-configuration.js
```

## 7. Agent profile và runtime configuration

### Source of truth

Profile chính thức nằm trong bảng `agent_profiles`, được truy cập qua:

```text
backend/src/modules/agent/agent-profile-store.js
```

Application service:

```text
backend/src/application/agent-settings-service.js
```

Projection runtime:

```text
backend/src/modules/agent/node-agent-configuration.js
```

Luồng chuẩn:

```text
UI
  → Agent Settings Service
  → agent_profiles
  → configuration.sync()
  → agent-config.json
```

`agent-config.json` chỉ là derived projection, không phải nguồn sự thật.

### Schema hiện tại

Schema:

```text
schemas/governance/agent-profile.schema.json
```

Required fields:

```text
agent_id
agent_name
role
gateway_url
credential_ref
enabled
status
created_at
updated_at
```

Role enum:

```text
coder
reviewer
sprint_leader
architecture_manager
```

Status enum:

```text
ready
working
not_connected
```

### Identity semantics

Thiết kế hiện tại tách đúng ba khái niệm:

```text
agent_id   = UUID kỹ thuật
agent_name = nickname/display name do user nhập
role       = vai trò chức năng
```

Các agent cũ `architecture-manager`, `sprint-leader`, `builder`, `reviewer` đã được migrate trong database live sang UUID. Các UUID từng quan sát:

```text
52a6913b-304d-4548-8f1c-54b7d9139637
885b2b5f-5247-4dfc-8f05-968de25391dc
4c01af79-98c0-4d10-b6ed-c815d4911fe6
85661178-4828-4942-a4fb-6177bbb24040
```

API live đã trả nickname như `Legend Architecture`, `Viva Leader`, `Coder Cú đêm`, `Siêu soi`.

### CRUD service

`agent-settings-service.js` hiện cung cấp:

```text
list()
get()
create()
save()
remove()
testConnection()
```

Service đã:

- sinh UUID mới bằng `randomUUID()` trong trường hợp phù hợp,
- giữ UUID hiện có,
- normalize/validate role và status,
- sync runtime configuration ngay sau create/save/delete,
- mask API key trong response,
- lưu credential qua `credential_ref` và secret store riêng,
- hỗ trợ legacy ID lookup trong giai đoạn tương thích.

### Các điểm chưa đồng nhất

1. `node-agent-configuration.js` hiện chưa đưa `role` vào `REQUIRED_FIELDS`; schema profile yêu cầu role nhưng runtime projection chưa enforce/project đầy đủ.
2. `agent-settings-service.js` provider list là `codex`, `claude`, `openai`, `anthropic`, `custom`, trong khi node configuration còn cho `devquote`.
3. Live profile có `provider: anthropic` và gateway domain Devquote; cần chốt Devquote là gateway/vendor hay provider chính thức.
4. Schema vẫn cho phép legacy IDs dù mục tiêu thiết kế là UUID-only.
5. `resolveAgentId()` hiện chấp nhận string non-empty không phải UUID; UUID format chưa được enforce nghiêm ngặt ở service boundary.
6. Record tương ứng với `sprint-leader` từng được quan sát có `role: coder`; role nghiệp vụ đúng phải là `sprint_leader` và cần kiểm tra lại database live.
7. Fixtures cũ có thể còn thiếu `role` hoặc dùng status/provider cũ.


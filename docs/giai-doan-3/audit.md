# NodeForge — Comprehensive Project Audit

**Ngày rà soát:** 2026-09-09  
**Phạm vi:** toàn bộ repository, backend runtime, agent pipeline, API, schema, workflow, frontend, test và trạng thái triển khai local.

## 1. Tổng quan dự án

NodeForge là hệ thống điều phối multi-agent. NodeForge không trực tiếp suy luận hay viết code thay agent; NodeForge quan sát filesystem, duy trì code index, chuẩn hóa context/protocol, điều phối supervisor và worker, chạy verification, lưu event/history và stream trạng thái về UI.

Mô hình tổng quát:

```text
Human / UI
   │
   ▼
NodeForge Control API
   │
   ▼
Supervisor theo từng task
   │
   ├── Sender Queue → Sender Worker → Agent Gateway → AI Agent
   │
   ├── Materializer Queue → Materializer Worker
   │                              ├── Valid Patch
   │                              └── Invalid Patch
   │
   ├── Verification Worker
   │
   └── Repair Worker
```

Các nguyên tắc kiến trúc chính:

- Filesystem và Git là source of truth của source project.
- `.forge/` là runtime/config state do NodeForge quản lý.
- Agent được phép trực tiếp đọc/ghi source project.
- NodeForge quan sát filesystem, không cần proxy từng thao tác file của agent.
- Worker chỉ thực hiện một loại công việc; Supervisor mới điều phối vòng đời task.
- Schema là contract giữa các thành phần.
- Context được chọn lọc qua index, graph, summary và budget; không đưa toàn bộ project cho AI.
- Verification chính thức là kết quả do NodeForge lập kế hoạch, chạy, chuẩn hóa và persist.

## 2. Cấu trúc repository

Các khu vực chính:

```text
nodeforge/
├── backend/        # NodeForge backend và tests
├── frontend/       # Next.js frontend hiện tại
├── ui/             # frontend/client Next.js khác và build artifact
├── schemas/        # protocol và domain contracts
├── workflows/      # workflow state machines
├── docs/           # architecture, plans, sprints, reports
├── backup/         # tài liệu/schema cũ
├── config/         # cấu hình mặc định
├── agent-tool/     # tool runtime/handlers
├── Skills/         # hướng dẫn coding
└── .forge/         # runtime state local
```

`STRUCTURE.md` mô tả layout module theo hướng `src/bootstrap`, `src/application`, `src/domain`, `src/modules`, `src/infrastructure`, `src/transport` và `src/shared`. Repository thực tế hiện có thêm các khu vực legacy/parallel như `backend/src/agents`, `backend/src/core` và cả hai `frontend/`, `ui/`, vì vậy cấu trúc thực tế chưa hoàn toàn khớp tài liệu lý tưởng.

Tại thời điểm audit, working tree có khoảng **151 file modified** và **96 file untracked**. Đây là trạng thái thay đổi rộng, bao gồm cả runtime/generated/test/tài liệu và nhiều feature khác nhau. Không được reset, cleanup hoặc commit toàn bộ một cách mù quáng; trước hết phải phân loại từng nhóm thay đổi.

## 3. Cách khởi động và composition root

Các lệnh chính trong `package.json`:

```bash
pnpm dev
npm run dev:node
npm run dev:watcher
npm run dev:forge
npm test
npm run lint
npm run typecheck
npm run validate:schemas
```

`pnpm dev` gọi `backend/scripts/dev-workspace.mjs`, dự kiến khởi động:

```text
Control API  :3100
Filesystem Watcher
Code Index
Next.js UI   :3003
```

Composition root production là:

```text
backend/scripts/start-control-api.mjs
```

Luồng khởi động:

```text
load env
  → read runtime config
  → create storage
  → create profile/secrets/gateway
  → create platform services
  → create production supervisor runtime
  → recover previous tasks
  → start workers
  → start HTTP API
```

Các service được nối trong composition root gồm:

- SQLite/control database và index database.
- File service và protocol storage.
- Agent profile store.
- Node agent configuration projection.
- Secret backend.
- Agent gateway.
- Roadmap, sprint, ticket status và dashboard.
- Event store, subscription và unified stream.
- Context engine, code search và relevant tree selector.
- Verification orchestrator.
- Production supervisor runtime.
- HTTP server và Forge v1 router.

Ngoài production composition root còn có `backend/src/bootstrap/index.js`, phục vụ `createBootstrap()` cho watcher/indexer/agent process pipeline. Cần xác định rõ abstraction nào là lifecycle chính, abstraction nào chỉ dùng cho test hoặc legacy; hiện hai hướng lifecycle cùng tồn tại.

## 4. Filesystem watcher và code index

### Watcher

Các thành phần:

```text
backend/src/infrastructure/filesystem/watcher.js
backend/src/infrastructure/filesystem/file-service.js
backend/src/modules/watcher/
backend/scripts/start-project-watcher.mjs
```

Watcher xử lý các event:

```text
CREATE, MODIFY, DELETE, RENAME, MOVE
```

Watcher phải bỏ qua ít nhất:

```text
.forge/**
.git/**
node_modules/**
dist/**
coverage/**
```

Để tránh đọc file khi agent còn đang ghi, pipeline cần debounce và file-stability check trước khi re-index.

### Code index

Các module chính nằm trong `backend/src/modules/index/`:

- `code-search.js`
- `code-index-summary-builder.js`
- `context-planner.js`
- `dependency-graph.js`
- `file-graph.js`
- `function-graph.js`
- `consistency-checker.js`
- `file-repository.js`

Code index cung cấp file/symbol/import/export/dependency/call/reference/test/summary/graph. Index là cache có cấu trúc, không phải source of truth. Khi index không nhất quán phải có khả năng full rebuild.

Context pipeline hiện theo hướng:

```text
Code Index
  → symbol selection
  → dependency selection
  → line-range selection
  → deduplication
  → structural/history/test summary
  → Context Pack
  → Builder / Reviewer
```

## 5. Persistence và runtime state

Infrastructure persistence:

```text
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

## 8. Provider pipeline

Provider adapters hiện có:

```text
backend/src/modules/agent/provider-adapters/
├── anthropic-adapter.js
├── claude-adapter.js
├── codex-adapter.js
├── custom-adapter.js
├── devquote-adapter.js
├── openai-adapter.js
├── openai-request-builder.js
├── openai-response-normalizer.js
└── openai-transcript-resolver.js
```

Pipeline mục tiêu:

```text
Canonical request
  → provider-specific mapping
  → provider transport
  → provider response normalization
  → canonical result
```

Đã chuyển theo hướng provider-neutral:

- Canonical payload được shape trước mapping.
- Claude/Anthropic và Devquote không nhận OpenAI-shaped payload.
- OpenAI-specific mapping nằm trong OpenAI adapter/builder.

Claude mapping phải giữ:

```text
instruction_blocks → system content blocks
cacheable: true     → cache_control: { type: "ephemeral" }
user_blocks         → initial user message
transcript_blocks   → assistant/tool history
capabilities        → tools
expected_output.transport = function_tool
expected_output.type      = code_needed
                       → forced tool call
```

Cần tiếp tục kiểm tra:

- `claude` và `anthropic` là provider riêng hay alias.
- `devquote` có cần xuất hiện trong schema/service hay không.
- canonical schema có bao phủ đầy đủ mọi adapter.
- transcript fallback khi provider chain hết hiệu lực.
- usage/cache metadata và raw response khi normalization lỗi.
- test provider thực tế thay vì chỉ test request builder.

## 9. Supervisor và worker pipeline

Supervisor production:

```text
backend/src/modules/supervisor/production-runtime.js
backend/src/modules/supervisor/supervisor-runtime.js
backend/src/modules/supervisor/supervisor-manager.js
backend/src/modules/supervisor/round-controller.js
backend/src/modules/supervisor/nodeforge-task-integration.js
```

Mô hình là một supervisor cho mỗi task:

```text
Task A → Supervisor A
Task B → Supervisor B
Task C → Supervisor C
```

Supervisor giữ task state, context, request/round state, retry/recovery và quyết định bước kế tiếp. NodeForge giao task và nhận kết quả cuối.

### Queue và worker

Các queue/store:

```text
durable-queue.js
file-queue-store.js
processed-request-store.js
execution-event-bus.js
```

Luồng chuẩn:

```text
Supervisor
  → sender queue
  → sender worker
  → Agent Gateway
  → Agent response
  → Supervisor
  → materializer queue
  → materializer worker
  → VP / iVP
```

Sau materialization:

```text
VP  → verification queue → verification worker → result event → Supervisor
iVP → repair queue        → repair worker        → result event → Supervisor
```

Worker không được tự điều phối worker khác bằng function call; giao tiếp đúng là command qua queue và event qua event bus.

### Recovery

Production runtime gọi `recover()` trước khi start workers. Sau restart cần:

- đọc state mới nhất,
- tìm round/task chưa terminal,
- kiểm tra persistence/provider status/checksum,
- polling nếu provider còn pending,
- dựng transcript fallback nếu chain mất,
- không tạo request mới khi round cũ chưa kết luận.

## 10. Materializer, patch và verification

Execution handlers:

```text
backend/src/application/execution-handlers/
├── apply-patch.js
├── backup.js
├── full-file-replace.js
├── search-replace.js
├── structured-patch.js
├── unified-diff.js
└── verify-checksum.js
```

Các lớp bảo vệ hiện có:

- validate patch wrapper/hunk/context,
- kiểm tra path đúng file yêu cầu,
- kiểm tra line position,
- checksum/concurrent modification detection,
- atomic apply gate,
- backup và repair khi apply thất bại.

Verification modules:

```text
backend/src/modules/verification/
├── check-runner.js
├── command-executor.js
├── orchestrator.js
├── runner.js
└── verification-plan-builder.js
```

Verification hỗ trợ các nhóm:

```text
test
build
lint
typecheck
```

Chỉ kết quả NodeForge chạy, normalize và persist mới được coi là evidence verification chính thức.

## 11. Event, history, governance và memory

Event modules:

```text
backend/src/modules/events/
```

Bao gồm event publisher/store, persistent store, subscriptions và unified stream ordering.

History/memory:

```text
backend/src/modules/history/
```

Bao gồm history store, memory retriever, project memory và task summary.

Governance:

```text
backend/src/modules/governance/
```

Bao gồm:

- agent communication bus/store,
- architecture decisions,
- architecture knowledge model,
- governance dependency graph,
- governance rules engine,
- roadmap/sprint/governance orchestration.

HTTP/API đã có endpoint history, dashboard, architecture workspace và human decision để truy cập các lớp này.

## 12. Forge v1 API

Router chính:

```text
backend/src/transport/http/forge-v1-router.js
```

HTTP server:

```text
backend/src/transport/http/server.js
```

### System

```http
GET /forge/v1/health
GET /forge/v1/version
```

### Agents

```http
GET    /forge/v1/agents
POST   /forge/v1/agents
GET    /forge/v1/agents/:id
PUT    /forge/v1/agents/:id
DELETE /forge/v1/agents/:id
POST   /forge/v1/agents/:id/test
```

Route connection test chính xác là:

```http
POST /forge/v1/agents/{UUID}/test
```

Route này đã được kiểm tra live trên cả `127.0.0.1:3100` và `192.168.1.181:3100`, trả HTTP 200 và trạng thái `CONNECTED`.

### Project/dashboard/history

```http
GET  /forge/v1/projects/:projectId/dashboard
GET  /forge/v1/projects/:projectId/tickets/:ticketId
GET  /forge/v1/projects/:projectId/tickets/:ticketId/graph
GET  /forge/v1/projects/:projectId/history
POST /forge/v1/projects/:projectId/history
```

### Architecture/decisions

```http
POST /forge/v1/projects/:projectId/decisions
GET  /forge/v1/architecture-workspace
GET  /forge/v1/projects/:projectId/architecture-workspace
```

### Sprints/tickets

```http
POST   /forge/v1/sprints
GET    /forge/v1/sprints
GET    /forge/v1/sprints/:sprintId
PUT    /forge/v1/sprints/:sprintId
DELETE /forge/v1/sprints/:sprintId
POST   /forge/v1/sprints/:sprintId/run
DELETE /forge/v1/projects/:projectId/tickets/:ticketId
POST   /forge/v1/projects/:projectId/tickets/:ticketId/run
```

### Conversations/SSE

```http
POST /forge/v1/projects/:projectId/conversations
POST /forge/v1/projects/:projectId/conversations/:conversationId/messages
GET  /forge/v1/projects/:projectId/conversations/:conversationId/stream
```

Server có CORS, OPTIONS, request/correlation ID, body limit, JSON error handling và SSE disconnect protection.

### API inconsistency

`forge-v1-router.js` đã nhận CRUD agent, nhưng `server.js` vẫn chứa các direct/legacy routes và validation cũ. Validation hiện vẫn chỉ yêu cầu:

```text
list(), save(), testConnection()
```

Trong khi service đã có:

```text
list(), get(), create(), save(), remove(), testConnection()
```

Cần xác định route owner duy nhất và loại bỏ hoặc cô lập route legacy để tránh behavior khác nhau.

## 13. Frontend

Hiện có hai frontend source/artifact:

```text
frontend/
ui/nextjs/
ui/dist/
```

### `frontend/`

Đây là Next.js app hiện tại, dùng Next.js `16.3.3` và React `19.2.8`, chạy port `3003`.

Các page hiện có:

```text
frontend/src/app/page.jsx
frontend/src/app/agents/page.jsx
frontend/src/app/login/page.jsx
```

Component chính:

```text
frontend/src/components/Header.jsx
```

UI hiện còn sơ khai:

- Home page có giới thiệu NodeForge.
- Agents page mới có heading/mô tả, chưa có list/CRUD.
- Login page tồn tại nhưng chưa xác nhận auth flow hoàn chỉnh.
- Header có logo, Agents và Login.

### Theme và navigation

Yêu cầu UI trước đó:

- đưa `NODE ONLINE | PROJECT NODEFORGE | ...` cạnh logo,
- bỏ gear icon,
- thay bằng ThemeToggle,
- lưu theme,
- đồng bộ theme trên mọi page.

Hiện Header chưa có status row hoặc ThemeToggle. `globals.css` vẫn có CSS mặc định từ template và `prefers-color-scheme`, trong khi page dùng nhiều CSS variables riêng. Theme system chưa được triển khai hoàn chỉnh.

### API client

`ui/nextjs/lib/node-client.js` đã dùng các route `/forge/v1/agents` và có:

```text
getAgents()
getAgent(agentId)
createAgent(settings)
saveAgentSettings(agentId, settings)
testAgentConnection(agentId)
```

Nhưng client này không nằm cùng source page `frontend/src`, tạo ra nguy cơ UI/client/build chạy từ hai nơi khác nhau.

## 14. Schemas

Schema domains hiện có:

```text
agent, context, core, execution, governance, log, node,
project, results, roadmap, stream, supervisor, verification, worker
```

Contracts bao phủ:

- envelope/command/event/error,
- agent profile/request/response/tools,
- node profile/capability/state,
- project/task/session/workflow/rule/permission,
- context pack,
- execution,
- verification/test/check/review result,
- roadmap/sprint/commit,
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
- UUID connection-test route.
- Secret reference/masking.
- Schema-driven contracts.
- Roadmap/sprint/ticket/dashboard.
- SSE stream cơ bản.

### Đã làm nhưng chưa reconcile

- Profile schema với runtime projection.
- Provider enum giữa schema/service/adapter.
- UUID-only với legacy compatibility.
- Forge v1 router với direct routes trong server.
- `frontend/` với `ui/nextjs/`.
- Bootstrap abstraction với production runtime.
- Workflow definition với ruleset mặc định.
- Active schema với legacy schema/fixture.
- Root runtime database với backend runtime database.
- Migration role/nickname của agent.

### Chưa hoàn chỉnh

- UI CRUD agent đầy đủ.
- ThemeToggle, status row và theme synchronization.
- Authentication/login thực tế.
- Full test suite xanh.
- Strict UUID enforcement.
- Provider vocabulary chính thức.
- Ruleset mặc định.
- Xác định một frontend source duy nhất.
- Cô lập/xóa legacy API routes.
- API contract/error documentation hoàn chỉnh.
- Deployment/process verification tự động.

## 20. Các vấn đề ưu tiên

### P0 — Không làm mất thay đổi hiện có

Phân loại 151 modified và 96 untracked trước mọi cleanup hoặc commit. Tách runtime/generated files, feature changes, legacy files, temporary test scripts và tài liệu.

### P1 — Chốt agent contract

- Thêm `role` vào node configuration required/projected fields.
- Kiểm tra và sửa role của sprint leader.
- Chốt provider `anthropic`/`claude`/`devquote`.
- Cập nhật schema, service, adapter và fixtures đồng bộ.
- Enforce UUID nếu UUID là contract cuối cùng.
- Quyết định thời điểm bỏ legacy ID.

### P1 — Chốt frontend

Chọn `frontend/` hoặc `ui/nextjs/` làm source chính. Di chuyển API client/page/test về cùng một cấu trúc; không duy trì ba nguồn (`frontend`, `ui/nextjs`, `ui/dist`) như các nguồn cạnh tranh.

### P1 — Chốt API ownership

Một route chỉ nên có một implementation. Forge v1 router phải là owner của `/forge/v1`; direct/legacy handling trong `server.js` phải được xóa hoặc đánh dấu rõ boundary.

### P1 — Sửa contract/test drift

Khôi phục hoặc tạo đúng ruleset mặc định; cập nhật test path frontend; làm deterministic tool tests không phụ thuộc agent ngẫu nhiên/provider bên ngoài.

### P2 — Hardening runtime

- xác nhận cwd/dataDir/database path trong startup log;
- kiểm tra restart/recovery nhiều task;
- kiểm tra duplicate request/event;
- kiểm tra VP/iVP và repair loop;
- kiểm tra provider error/timeout/retry;
- kiểm tra security policy trên mọi execution handler.

## 21. Thứ tự triển khai đề nghị

### Giai đoạn A — Baseline

1. Phân loại toàn bộ git diff/untracked.
2. Xác định generated/runtime và file cần track.
3. Chọn frontend chính.
4. Chọn provider vocabulary.
5. Xác định process/database path chuẩn.

### Giai đoạn B — Agent contract

1. Chốt schema profile.
2. Chốt UUID/legacy policy.
3. Đồng bộ profile store, service, projection và API.
4. Migrate/validate database.
5. Cập nhật fixtures.
6. Test CRUD và connection test.

### Giai đoạn C — Runtime pipeline

1. Kiểm tra composition root.
2. Kiểm tra supervisor recovery.
3. Kiểm tra durable queue/idempotency.
4. Kiểm tra materializer VP/iVP.
5. Kiểm tra verification/repair.
6. Kiểm tra event correlation.

### Giai đoạn D — Provider

1. Chốt canonical request.
2. Test Anthropic/Claude mapping.
3. Test OpenAI mapping.
4. Test Codex/Devquote/custom.
5. Test forced `code_needed` tool call.
6. Test transcript/cache/usage/error.

### Giai đoạn E — API

1. Chốt route Forge v1.
2. Cô lập legacy routes.
3. Đồng nhất service validation.
4. Chuẩn hóa error/status code.
5. Test local/LAN/restart.

### Giai đoạn F — UI

1. Chọn frontend source.
2. Nối agent API client.
3. Implement list/create/edit/delete/test connection.
4. Implement status row.
5. Implement ThemeToggle và persistence/synchronization.
6. Chạy Next build và browser test.

### Giai đoạn G — Verification cuối

```bash
npm run validate:schemas
npm run lint
npm run typecheck
npm test
```

Sau đó chạy backend smoke test, API smoke test, UI build/browser test và `git diff --check`.

## 22. Kết luận

NodeForge đã có phần lớn nền tảng của một orchestrator multi-agent thực tế: profile, gateway, provider pipeline, protocol state, queue, supervisor, materializer, verification, repair, event/history, code index, schema và Forge v1 API.

Trạng thái hiện tại là **nhiều subsystem đã được triển khai nhưng baseline chưa được reconcile hoàn toàn**. Các điểm load-bearing cần xử lý trước khi mở rộng tính năng là:

1. Đồng nhất agent profile contract giữa schema, database, service và runtime projection.
2. Chọn một frontend source và một API route owner.
3. Chốt provider vocabulary.
4. Khôi phục ruleset và cập nhật test/fixture drift.
5. Phân loại working tree trước khi tiếp tục sửa hoặc commit.

UUID connection-test route hiện hoạt động live; full repository vẫn chưa xanh vì còn 12 test failure và các inconsistency nêu trên.

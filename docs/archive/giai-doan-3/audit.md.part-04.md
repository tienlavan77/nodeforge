<!-- Preserves an ordered historical design section so repository restructuring retains the full technical discussion and can verify its original checksum after splitting. -->
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

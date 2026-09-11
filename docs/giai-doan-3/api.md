# NodeForge API v1 Proposal

## Muc tieu

NodeForge hien co nhieu route o nhieu namespace (`/projects`, `/tasks`, `/sessions`, `/agents`) va dang tron resource API voi command runtime. Tai lieu nay de xuat mot API surface thong nhat duoi `/forge/v1`.

Muc tieu cua v1:

- Co version prefix on dinh de co the phat trien v2 ma khong pha UI hien tai.
- Tach resource, command, event stream va internal worker API.
- Dam bao command chi tra `accepted` sau khi request da duoc persist va enqueue thanh cong.
- Giua `request_id`, `correlation_id`, idempotency va error contract nhat quan.
- Khong expose raw provider payload, filesystem path, queue mutating API hoac repository dump.

## Nguyen tac thiet ke

### 1. Versioned namespace

Tat ca public endpoint moi bat dau bang `/forge/v1`. Version nam trong URL de client co the pin contract va server co the duy tri nhieu version song song.

### 2. Resource va command tach biet

Danh tu so nhieu dung cho resource (`projects`, `tickets`, `executions`). Hanh dong lam thay doi lifecycle dung command suffix (`:run`, `:retry`, `:cancel`) thay vi chen logic vao mot `POST` khong ro nghia.

### 3. Accepted phai co y nghia

`202 Accepted` chi duoc tra sau khi Node da persist command, tao correlation metadata va enqueue job vao queue. Neu enqueue that bai, API tra loi loi; khong duoc tra `accepted` gia.

### 4. Idempotency va traceability

Command mutating nhan `Idempotency-Key`. Moi response command co `request_id`, `correlation_id` va resource id de UI theo doi den khi ket thuc.

### 5. Controlled access

Code Intelligence va transcript retrieval bat buoc co execution scope, allowed paths va context budget. Khong co endpoint lay toan bo repository.

### 6. Project context parameter

API co the nhan project context qua `project_id` trong JSON payload hoac qua query parameter `?project={project_id}`. Command co body dung `project_id`; read/page-load co the dung `?project=...`; server normalize ve mot gia tri noi bo. Neu ca hai nguon cung ton tai nhung khac nhau, tra `409 PROJECT_CONTEXT_CONFLICT`. Moi resource van phai authorization theo project.

## Nhom API

### System / Platform

Dung cho load balancer, UI shell va operational tooling.

```text
GET /forge/v1/health
GET /forge/v1/ready
GET /forge/v1/version
GET /forge/v1/metrics
```

`health` chi kiem tra process con song. `ready` kiem tra database, queue, worker, Agent Gateway va File Service. `metrics` chi nen cho admin/observability.

### Projects

```text
GET    /forge/v1/projects
POST   /forge/v1/projects
GET    /forge/v1/projects/{project_id}
PATCH  /forge/v1/projects/{project_id}
DELETE /forge/v1/projects/{project_id}
GET    /forge/v1/projects/{project_id}/dashboard
GET    /forge/v1/projects/{project_id}/memory
```

Project la boundary chinh cho authorization, Code Graph, tickets, conversations va audit.

### Tickets

```text
GET    /forge/v1/tickets?project={project_id}
POST   /forge/v1/tickets
GET    /forge/v1/tickets/{ticket_id}?project={project_id}
PATCH  /forge/v1/tickets/{ticket_id}
DELETE /forge/v1/tickets/{ticket_id}
GET    /forge/v1/tickets/{ticket_id}/graph?project={project_id}
```
tryen project_id vao payload
Ticket la plan-level resource. Viec chay ticket khong nen la CRUD update ma la command rieng:

```text
POST /forge/v1/tickets/{ticket_id}:run
POST /forge/v1/tickets/{ticket_id}:retry
POST /forge/v1/tickets/{ticket_id}:resume
POST /forge/v1/tickets/{ticket_id}:cancel
```

Response chuan cho `:run`:

```json
{
  "ticket_id": "FORGE-UI-052",
  "supervisor_id": "SUP-...",
  "status": "accepted",
  "pipeline": "supervisor",
  "request_id": "REQ-...",
  "correlation_id": "CORR-..."
}
```

`status=accepted` chi xac nhan command da duoc tiep nhan va dispatch; trang thai thuc te doc qua Execution API hoac event stream.

### Executions / Supervisor

Execution la runtime resource cua mot lan chay ticket. `supervisor_id` la identity noi bo/legacy; `execution_id` nen la id cong khai.

```text
GET  /forge/v1/executions
POST /forge/v1/executions
GET  /forge/v1/executions/{execution_id}
GET  /forge/v1/executions/{execution_id}/state
GET  /forge/v1/executions/{execution_id}/rounds
GET  /forge/v1/executions/{execution_id}/events
POST /forge/v1/executions/{execution_id}:cancel
POST /forge/v1/executions/{execution_id}:retry
```

Execution response de nghi:

```json
{
  "execution_id": "SUP-...:14",
  "task_id": "FORGE-UI-052",
  "supervisor_id": "SUP-...",
  "state": "WAITING_AGENT",
  "round": 2,
  "attempt": 1,
  "created_at": "2026-09-07T00:00:00Z",
  "updated_at": "2026-09-07T00:01:00Z"
}
```

Supervisor state hien tai:

```text
CREATED -> PREPARING -> READY -> REQUESTING -> WAITING_AGENT
WAITING_AGENT -> REQUESTING | MATERIALIZING | VERIFYING | REPAIRING | FAILED
MATERIALIZING -> VERIFYING | REPAIRING | FAILED
VERIFYING -> COMPLETED | REPAIRING | FAILED
REPAIRING -> WAITING_REPAIR | MATERIALIZING | NEEDS_HUMAN_REVIEW | FAILED
WAITING_REPAIR -> REQUESTING | MATERIALIZING | FAILED
```

`COMPLETED`, `FAILED` va `NEEDS_HUMAN_REVIEW` la terminal state. Retry phai tao attempt moi va ghi audit event, khong silently reuse request cu.

### Conversations

```text
GET  /forge/v1/conversations?project={project_id}
POST /forge/v1/conversations
GET  /forge/v1/conversations/{conversation_id}?project={project_id}
POST /forge/v1/conversations/{conversation_id}/messages
GET  /forge/v1/conversations/{conversation_id}/events?project={project_id}
```
truyen project_id vao payload
Endpoint `events` thay cho ten `stream` de the hien day la event feed. Ho tro `Last-Event-ID`, cursor va reconnect.

### Sprints / Planning

```text
GET    /forge/v1/sprints?project={project_id}
POST   /forge/v1/sprints?project={project_id}
GET    /forge/v1/sprints/{sprint_id}?project={project_id}
PUT    /forge/v1/sprints/{sprint_id}?project={project_id}
DELETE /forge/v1/sprints/{sprint_id}?project={project_id}
POST   /forge/v1/sprints/{sprint_id}/run?project={project_id}
```
truyen project_id vao payload

Sprint plan la planning artifact; sprint execution la command runtime rieng.

### Agents

```text
GET  /forge/v1/agents
GET  /forge/v1/agents/{agent_id}
GET  /forge/v1/agents/{agent_id}/health
GET  /forge/v1/agents/{agent_id}/capabilities
GET  /forge/v1/agents/{agent_id}/settings
PUT  /forge/v1/agents/{agent_id}/settings
POST /forge/v1/agents/{agent_id}:test
```

Khong expose truc tiep provider secret, raw prompt hoac queue mutating API.

### Human decisions

```text
GET  /forge/v1/decisions
POST /forge/v1/decisions
GET  /forge/v1/decisions/{decision_id}
POST /forge/v1/decisions/{decision_id}:resolve
```
truyền project_id vao payload

Decision la resource audit duoc tao boi human; resolve la command co idempotency.

### Code Intelligence

```text
POST /forge/v1/code/search
POST /forge/v1/code/symbols/search
POST /forge/v1/code/read
POST /forge/v1/code/transcript
GET  /forge/v1/code/graph
```
truyền project_id vao page load 

Moi request phai gioi han scope va budget:

```json
{
  "paths": ["frontend/src/components/Header.jsx"],
  "symbols": ["Header"],
  "budget": { "max_bytes": 50000, "max_files": 4 }
}
```

Khong tao `/repository/all`, `/files` khong gioi han, hoac endpoint dump repository. Tool va HTTP API phai dung chung permission, task scope va File Service.

### Audit

```text
GET /forge/v1/audit
GET /forge/v1/history
GET /forge/v1/executions/{execution_id}/audit
```

Filter de nghi: `actor`, `event_type`, `task_id`, `execution_id`, `correlation_id`, `from`, `to`, `cursor`, `limit`.

### Internal workers

Queue khong phai public HTTP resource. Cac channel noi bo hien tai:

```text
agent.request
materializer.request
verification.request
repair.request
```

Neu can debug development/admin, chi expose read-only:

```text
GET /forge/v1/internal/queues
GET /forge/v1/internal/workers
GET /forge/v1/internal/workers/{worker_id}
```

Bat buoc feature flag va admin authorization cho nhom nay.

## Contract chung

### Command headers

```text
Authorization: Bearer <token>
Idempotency-Key: <client-generated-key>
X-Correlation-ID: <optional-client-correlation>
If-Match: <etag>                 # cho PATCH
```

Server luon tao `request_id` neu client khong gui. `correlation_id` duoc propagate qua Supervisor, queue, worker, Agent va audit.

### Error envelope

```json
{
  "error": {
    "code": "DISPATCH_NOT_ENQUEUED",
    "message": "Execution request was not queued.",
    "request_id": "REQ-...",
    "correlation_id": "CORR-...",
    "details": {}
  }
}
```

Khong tra raw stack trace, provider response, secret, hoac filesystem absolute path.

### HTTP status

```text
200 OK                  read/update thanh cong
201 Created             tao resource
202 Accepted            command da persist + enqueue
204 No Content          delete thanh cong
400 Bad Request         JSON/field khong hop le
401 Unauthorized        thieu identity
403 Forbidden           khong du permission/scope
404 Not Found           resource khong ton tai
409 Conflict            idempotency/state/version conflict
422 Unprocessable       schema hop le nhung business invalid
429 Too Many Requests  budget/rate limit
500/503                 loi server/not ready
```

## Migration tu route hien tai

| Legacy | V1 de xuat |
| --- | --- |
| `POST /projects/{p}/tickets/{t}/run` | `POST /forge/v1/projects/{p}/tickets/{t}:run` |
| `GET /projects/{p}/tickets/{t}` | `GET /forge/v1/projects/{p}/tickets/{t}` |
| `GET /projects/{p}/dashboard` | `GET /forge/v1/projects/{p}/dashboard` |
| `POST /projects/{p}/conversations/{c}/messages` | `POST /forge/v1/projects/{p}/conversations/{c}/messages` |
| `GET /projects/{p}/conversations/{c}/stream` | `GET /forge/v1/projects/{p}/conversations/{c}/events` |
| `POST /projects/{p}/sprint-plans/{s}/run` | `POST /forge/v1/sprints/{s}/run?project={p}` |
| `POST /tasks` | `POST /forge/v1/executions` |
| `GET /sessions/{id}` | `GET /forge/v1/executions/{id}` (adapter tam thoi) |

Legacy route nen duoc giu bang adapter, tra header `Deprecation` va log migration. UI chuyen sang v1 truoc; chi xoa legacy sau khi khong con client su dung.

## Thu tu trien khai

1. Tao versioned router `/forge/v1` va common middleware cho auth, request id, correlation id, idempotency va error mapping.
2. Di chuyen Ticket + Execution API truoc; day la duong chay anh huong truc tiep loi `accepted` nhung khong dispatch.
3. Sua `:run` de verify persist va queue enqueue truoc khi tra `202`.
4. Them Execution state/events va test end-to-end tu RUN den state transition.
5. Di chuyen Conversation/SSE.
6. Di chuyen Sprint, Agent, Decision va Code Intelligence.
7. Them legacy adapters, deprecation metrics va cutover UI.
8. Xoa route cu sau mot chu ky theo doi migration.

## Tieu chi san sang

- Moi command co request/correlation id va idempotency test.
- `202 Accepted` khong xuat hien neu queue enqueue that bai.
- UI doc state tu Execution API/event, khong suy dien tu accepted.
- Supervisor reset/retry co state transition va audit event ro rang.
- Code retrieval bi gioi han boi identity, capability, task scope va context budget.
- Legacy va v1 contract co integration test song song trong giai doan chuyen tiep.

<!-- Preserves an ordered historical design section so repository cleanup retains the complete original technical discussion and supports checksum reconstruction. -->
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

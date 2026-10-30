<!-- Preserves an ordered historical design section so repository cleanup retains the complete original technical discussion and supports checksum reconstruction. -->
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

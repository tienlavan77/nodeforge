# Ke hoach trien khai API `/forge/v1` song song

## Pham vi

Xay API versioned `/forge/v1` chay song song voi cac route hien tai. Khong doi ten, xoa, redirect hoac thay doi behavior cua legacy routes trong giai doan nay. Legacy va v1 dung chung application services, authorization, event bus va queue; chi khac lop routing/normalization.

## Muc tieu ky thuat

- Them versioned router ma khong lam thay doi `server.js` legacy contract.
- Chuan hoa `request_id`, `correlation_id`, `Idempotency-Key`, error envelope va project context.
- Command `:run`, `:retry`, `:resume`, `:cancel` chi tra `202 Accepted` sau khi persist + enqueue thanh cong.
- GET co the nhan `?project={project_id}`; body command dung `project_id`.
- Neu query va body co project khac nhau, tra `409 PROJECT_CONTEXT_CONFLICT`.
- UI cu tiep tuc dung legacy; client v1 duoc them de test/cutover tung phan sau.
- Khong expose raw provider payload, queue mutating API, filesystem path hay repository dump.

## Kien truc de xuat

```text
HTTP server
  -> legacy router (giu nguyen)
  -> forge/v1 router (moi)
       -> request context middleware
       -> v1 route handlers
       -> application services hien co
       -> Supervisor / queue / event bus
```

V1 router nen la module rieng, khong chen them hang loat dieu kien vao legacy `route()`. Hai router dung chung `writeJson`, body parser va error mapper nhung co route table rieng.

## Giai doan 1 - Nen tang router va contract

### Files du kien

- Tao `backend/src/transport/http/forge-v1-router.js`.
- Tao `backend/src/transport/http/api-contract.js` cho request/correlation id, project context, idempotency va error envelope.
- Cap nhat `backend/src/transport/http/server.js` de dispatch `/forge/v1/*` truoc khi fallback legacy.
- Khong sua semantics cac route legacy.

### Quy tac

- Path prefix bat buoc la `/forge/v1`.
- Request id doc tu header neu hop le, neu khong thi tao moi.
- Correlation id doc tu `X-Correlation-ID`, neu thieu thi tao theo request.
- `project_id` cua body va `project` query phai duoc normalize.
- Conflict project tra `409` voi code `PROJECT_CONTEXT_CONFLICT`.
- Loi luon co dang `{ error: { code, message, request_id, correlation_id, details } }`.
- Khong tra stack trace ra client.

### Test

- Route v1 khong lam thay doi ket qua test legacy.
- Unknown `/forge/v1` tra error envelope 404.
- Request/correlation id duoc tao va propagate.
- Project context tu body, query va conflict.

## Giai doan 2 - Ticket va Execution

Day la uu tien cao nhat vi lien quan truc tiep loi `accepted` nhung khong dispatch.

### Routes

```text
GET  /forge/v1/tickets?project={project_id}
POST /forge/v1/tickets
GET  /forge/v1/tickets/{ticket_id}?project={project_id}
PATCH/DELETE /forge/v1/tickets/{ticket_id}
GET  /forge/v1/tickets/{ticket_id}/graph?project={project_id}

POST /forge/v1/tickets/{ticket_id}:run
POST /forge/v1/tickets/{ticket_id}:retry
POST /forge/v1/tickets/{ticket_id}:resume
POST /forge/v1/tickets/{ticket_id}:cancel

GET  /forge/v1/executions
POST /forge/v1/executions
GET  /forge/v1/executions/{execution_id}
GET  /forge/v1/executions/{execution_id}/state
GET  /forge/v1/executions/{execution_id}/rounds
GET  /forge/v1/executions/{execution_id}/events
POST /forge/v1/executions/{execution_id}:retry
POST /forge/v1/executions/{execution_id}:cancel
```

### Implementation

- Tao adapter handler goi `dispatchTicket` hien co cho `:run`, nhung kiem tra enqueue/persist truoc khi response.
- Tao execution query service doc supervisor state store, protocol storage va event store; khong doc truc tiep queue file trong HTTP handler.
- Tao command idempotency store theo `Idempotency-Key` + project + resource + action.
- Retry tao attempt/request moi, ghi audit event va khong silently reuse request cu.
- Response `202` co `ticket_id`, `supervisor_id`, `request_id`, `correlation_id`, `status=accepted`, `pipeline=supervisor`.
- Neu command khong enqueue duoc, tra loi `DISPATCH_NOT_ENQUEUED`/`503`, khong tra accepted.

### Test

- V1 `:run` tra dung accepted khi queue enqueue thanh cong.
- V1 `:run` tra loi khi persist/enqueue that bai.
- Lap lai cung Idempotency-Key khong tao dispatch thu hai.
- Retry terminal execution tao attempt moi.
- Execution state/events doc dung supervisor hien tai.
- Legacy `POST /projects/.../run` van pass nguyen test.

## Giai doan 3 - Conversation va event stream

```text
GET  /forge/v1/conversations?project={project_id}
POST /forge/v1/conversations
GET  /forge/v1/conversations/{conversation_id}?project={project_id}
POST /forge/v1/conversations/{conversation_id}/messages
GET  /forge/v1/conversations/{conversation_id}/events?project={project_id}
```

- Tai su dung `ownerChatService` va `conversationStream`.
- Ho tro `Last-Event-ID`, cursor va reconnect.
- Khong doi endpoint SSE legacy.
- Test event ordering, reconnect va project conflict.

## Giai doan 4 - Projects, Sprints va Decisions

Them resource routes cho projects/dashboard/memory, sprints/sprint-plans va human decisions theo tai lieu API. Body command luon co `project_id`; GET co the dung `?project=`.

- Reuse `projectDashboardService`, `sprintPlanUploadService`, `dispatchSprint`, `humanDecisionService`.
- Them command idempotency cho sprint run, decision resolve.
- Test authorization/project isolation va legacy compatibility.

## Giai doan 5 - Agents va Code Intelligence

### Agents

Expose settings, capabilities, health va connection test qua adapter read-only/mutating da co. Khong expose secrets/provider payload.

### Code Intelligence

```text
POST /forge/v1/code/search
POST /forge/v1/code/symbols/search
POST /forge/v1/code/read
POST /forge/v1/code/transcript
GET  /forge/v1/code/graph?project={project_id}
```

- Dung chung `search_code`, `read_code`, `read_transcript_blocks` va Code Index.
- Bat buoc task scope, allowed paths, capability va context budget.
- Chi tra metadata/search result; full content chi qua read endpoint co scope.
- Tuyet doi khong them repository dump endpoint.

## Giai doan 6 - System, Audit va Internal read-only

```text
GET /forge/v1/health
GET /forge/v1/ready
GET /forge/v1/version
GET /forge/v1/metrics
GET /forge/v1/audit
GET /forge/v1/history
GET /forge/v1/internal/queues
GET /forge/v1/internal/workers
```

`internal` chi bat khi co feature flag + admin authorization. Queue khong co POST/DELETE public.

## Client va migration song song

- Tao helper v1 rieng trong `ui/nextjs/lib/node-client-v1.js`; khong doi helper legacy.
- Them feature flag `NEXT_PUBLIC_FORGE_API_V1` de bat tung nhom API.
- UI co the shadow-read execution state tu v1 trong development ma van hien thi du lieu legacy.
- Ghi metrics so sanh v1/legacy response, loi va latency.
- Them `Deprecation` header chi sau khi v1 da on dinh; chua xoa legacy.

## Thu tu file/code de trien khai

1. `api-contract.js` + `forge-v1-router.js` + route dispatch trong HTTP server.
2. Ticket command adapter + idempotency + execution query service.
3. V1 Conversation/SSE adapter.
4. V1 Project/Sprint/Decision adapters.
5. V1 Agent/Code Intelligence adapters.
6. Health/ready/metrics/audit/internal read-only.
7. V1 client, feature flag, shadow tests va migration metrics.

## Tieu chi hoan thanh

- Legacy test suite van xanh, khong co breaking change.
- Moi v1 route co integration test va error contract test.
- Moi command mutating co idempotency test.
- `202 Accepted` chi xuat hien sau persist + enqueue thanh cong.
- Execution state cua UI doc duoc tu v1 sau khi accepted.
- Project scope duoc normalize va enforce nhat quan.
- V1 chay cung process/queue voi legacy nhung co route/contract tach biet.

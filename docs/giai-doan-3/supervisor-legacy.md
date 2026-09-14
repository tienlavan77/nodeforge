# Pipeline Supervisor — bản đồ đầy đủ (hub-and-spoke)

> Ngày lập: 2026-09-11 · Đọc trực tiếp từ `backend/src/modules/supervisor/` tại commit `c8f026b`.
> Bản chính về kiến trúc tổng thể xem `audit-arch.md`; file này đi sâu vào Supervisor pipeline.

---

## 1. Vai trò

Supervisor là **hub duy nhất**. Tất cả workers (Sender, Materializer, Verification) là **spoke**: chỉ làm 1 việc chuyên biệt rồi trả kết quả về Supervisor qua event bus — không bao giờ worker gọi worker, không enqueue chéo.

Repair Worker không còn send: `repair-worker-production.js` chỉ build request, việc dispatch thuộc round-controller (xem mục 7).

---

## 2. Tài nguyên bền (durable state)

| Thành phần | File | Vị trí |
|---|---|---|
| Durable queue | `durable-queue.js` + `file-queue-store.js` | `.forge/runtime/queues/*.json` |
| Event bus | `execution-event-bus.js` | memory — bus trung tâm, mọi event đi qua đây |
| Supervisor state | `supervisor-state-store.js` | `.forge/runtime/supervisors/*.json` |
| Protocol storage | `protocol-storage.js` | `.forge/runtime/protocol-storage/task/{id}/round_{n}/{request,response}` — ref phẳng, checksum sha256 trong `.meta.json` |
| Processed requests | `processed-request-store.js` | `.forge/runtime/processed-requests/` — chống duplicate `request_id` |
| Signal/result/status buses | `worker-signal-bus.js`, `worker-result-bus.js`, `worker-status-bus.js` | memory — thức tỉnh poller + heartbeat worker |

Bốn queue: `agent.request`, `materializer.request`, `verification.request`, `repair.request`
(`repair.request` hiện không còn được enqueue — repair do round-controller build rồi đi qua `agent.request`).

---

## 3. State machine (12 trạng thái)

`supervisor-runtime.js`:

```text
CREATED → PREPARING → READY → REQUESTING → WAITING_AGENT → MATERIALIZING
        → VERIFYING → REPAIRING → WAITING_REPAIR → REQUESTING (lặp)
        └─────────────────────────────────────────→ COMPLETED / FAILED / NEEDS_HUMAN_REVIEW
```

Bảng chuyển `ALLOWED_TRANSITIONS` (hard-code, sai thứ tự = `ConfigurationError`):

```text
CREATED:        [PREPARING, REQUESTING, FAILED]
PREPARING:      [READY, FAILED]
READY:          [REQUESTING, FAILED]
REQUESTING:     [WAITING_AGENT, FAILED]
WAITING_AGENT:  [REQUESTING, MATERIALIZING, VERIFYING, REPAIRING, FAILED]
MATERIALIZING:  [VERIFYING, REPAIRING, FAILED]
VERIFYING:      [COMPLETED, REPAIRING, FAILED]
REPAIRING:      [WAITING_REPAIR, REQUESTING, MATERIALIZING, NEEDS_HUMAN_REVIEW, FAILED]
WAITING_REPAIR: [REQUESTING, MATERIALIZING, FAILED]
COMPLETED / FAILED / NEEDS_HUMAN_REVIEW: [] (terminal — reset() mới quay về CREATED)
```

---

## 4. Round controller — mạch 3 round + repair

`round-controller.js` (mặc định `ORIGIN_CODE_ROUND = 3`):

```text
R1 (task):           Supervisor gửi mô tả nhiệm vụ (instruction: task + conventions
                     + code_graph_candidates)
  → Agent trả code_needed  → Supervisor cấp summary context → sang R2

R2 (planning):       Supervisor gửi planning contract (+ planning-context block)
  → Agent trả planning (plan: [{path, action: NEW|MODIFY|READ_ONLY}])
  → validatePlan: mỗi item phải có path cụ thể + đúng 1 action; không trùng path
    (PLAN_INVALID / PLAN_DUPLICATE_PATH)
  → persistPlan → xin full source cho mọi MODIFY (assertFullContext: MODIFY thiếu
    content/exists là lỗi) → sang R3

R3 (code_provide):   Supervisor gửi full source + CODE_REQUIRE_INSTRUCTION +
                     STRUCTURED_PATCH_CONTRACT
  → Agent trả submit_code_response (files: structured patches)
  → KHÔNG gửi request tiếp → trả {materialize: true} → Supervisor đẩy
    materializer queue

R4, R5, … (repair):  requestRepair({reason: "materialization" | "verification"})
  → lấy invalid/failed patches, đóng gói: complete current source + correction text
  → nextRound = max(4, round+1) — giữ convention ref phẳng round_{n}
  → persist rồi enqueue lại sender queue
```

Response normalize: alias `request_info` → `code_needed`, `submit_code` →
`submit_code_response`; unwrap tối đa 5 tầng (`tool_use` / `payload` / text JSON).

Transcript block **append-only, bất biến khi đóng**:
- `block_id = round-{n}`; R2 lặp → `round-2.{k}`; dedup theo `request_id` (không theo round)
- refs tới protocol storage: `full_request_ref` / `full_response_ref`
- `in_window`: R1/R2-origin/R3 mở rộng được; `repair` và `planning_retry` luôn collapse
  về summary (R2 repeat được persist `replace:true` nên mở rộng sẽ resolve nhầm payload)
- `summarizeRound` nén mỗi block out-of-window thành 1 dòng mang đủ ý nghĩa
  (vd `submit_code_response: submitted 3 file(s)`)

---

## 5. Event bus — 8 loại event chính

```text
Sender ──► agent.response.received
Sender ──► agent.response.failed ───► Supervisor: FAILED → terminal task.failed

Supervisor-loop onEvent(agent.response.received):
  requestStore.claim (idempotency) → roundController.onResponse
    ├─ trả {request}        ─► REQUESTING → sender queue   (R1→R2, R2→R3)
    ├─ trả {materialize:false} ─► dừng (đã xử lý trong round controller)
    └─ mặc định / {materialize:true} ─► materializer queue

Materializer poller ─► material_verification.completed (valid)
                    ─► material_verification.invalid (có invalid)
  Supervisor quyết theo valid/invalid:
    hasInvalid → REPAIRING → startRepairRound("materialization")
    hasValid   → VERIFYING → verification queue
    rỗng cả hai → FAILED → terminal task.failed

Verification poller ─► verification.passed  → COMPLETED → terminal task.completed
                    ─► verification.failed  → REPAIRING → startRepairRound("verification")

Repair path: agent.response.received (R4+) → materialize → verify → lặp

Terminal: task.completed / task.failed (eventBus.publish)
```

Event đều có identity: `task_id, supervisor_id, request_id, correlation_id, attempt`
— `requestStore.claim(request_id, type)` chặn xử lý trùng.

---

## 6. Chi tiết từng worker

### Sender Worker (`sender-worker.js`)

- `processOnce`: claim `agent.request` → dedup qua `processedStore` → resolve adapter
  từ `agent-registry` → `runAgentTurns` → persist response **trước khi** publish
  (`sender.response_persisted`) → publish → ack.
- `runAgentTurns` — vòng lặp tối đa `max_turns` (mặc định 8):
  1. `adapter.send({agentId, payload, correlationId, tools})` — `toolsForRequest(job)`:
     1 response-function-tool theo expected_output (`code_needed` / `planning` /
     `submit_code_response`) + Forge tools mà `execution_context.capabilities` cho phép
     (`select_code_graph_candidates`, `search_code`, `read_code`,
     `read_transcript_blocks`, `read_file`, `write_diff`, `run_test`, `check_test`,
     `commit_changes`, `report_done`).
  2. Persist response mỗi turn (protocol storage, round = `payload.step_id`).
  3. Tool calls toàn là RESPONSE_FUNCTION_TOOLS (`code_needed`, `planning`,
     `submit_code_response`, `patch_repair_response`, `usage_needed`,
     `no_wiring_needed`, `completed`, `continue`) → đó là câu trả lời → return cho Supervisor.
  4. Ngược lại chạy từng Forge tool: context build từ `task_context` +
     `allowed_file_paths` (plan) + `transcript_blocks` trên payload; log
     `agent.tool_call` / `agent.tool_result`; append tool exchange vào
     `payload.messages` (anthropic shape: `tool_use`/`tool_result`, còn lại:
     `function_call`/`function_call_output`) rồi lặp.
  5. `report_done` → terminal, return ngay. Vượt `max_turns` → `TOOL_TURN_LIMIT`.
- Lỗi: persist raw response nếu có (`persistAgentResponse(raw:true)`), publish
  `agent.response.failed`, ack.

### Materializer Worker (`materializer-worker.js`)

- Mỗi patch kiểm tra 4 gate: `structure_ok`, `checksum_ok` (sha256), `anchor_ok`,
  `dry_apply_ok` (thử apply — qua `atomic-apply-gate.js` dùng fileService + gitService).
- Định dạng: `full_content` (ghi đè) vs `structured_patch` (diff).
- Đầu ra: `{valid, invalid, valid_patches, invalid_patches, repair_context}`;
  `PATCH_NOT_APPLICABLE` / `dry_apply_ok=false` → invalid cho repair round.

### Verification Worker (`verification-worker.js`)

- Duyệt `valid_patches`, `verify(patch)` từng cái → chia
  `passed_patches` / `failed_patches` → `status: "passed" | "failed"`.
- Node là nguồn sự thật verification (ARCHITECTURE.md mục 62) — Builder không được
  tự claim PASS.

---

## 7. Hai đường kích hoạt

| Đường | Entry point | Ghi ở đâu |
|---|---|---|
| Ticket từ UI/sprint | `dispatchTicket` → `dispatchTask` → `supervisorRuntime.integration.submitTicket` → `startTaskExclusive` → `supervisor-loop.start` (preparation → round controller) | `start-control-api.mjs:103-129`, `production-runtime.js:55-85` |
| Provider-specific nhanh (hello / codex tool loop) | `integration.submitTicket` chọn theo profile: `runOpenAiHello` / `runCodexTask` (ticket-driven function-calling loop, governance riêng) / `runToolTicket` (Claude MCP) | `nodeforge-task-integration.js:39-43` |

Cả hai đường cuối cùng đều enqueue `sender.handoff` / `agent.request` với
governance context (`allowed_file_paths`, `execution_context`) tương tự nhau.

---

## 8. Startup & recovery

`production-runtime.js`:
- `startWorkers()`: start sender + 2 poller; scan lại mọi job `queued`/`leased`
  còn tồn → phát `signalBus.wakeup` (startup-recovery) để xử lý nốt.
- `recover()`: recover từng queue + `supervisorManager.recover()` + resume loop
  cho state `pending` ở `CREATED`/`REQUESTING`/`WAITING_AGENT` (resume: true —
  không reset round controller).
- `startTaskExclusive`: mutex theo `task_id`; run lặp trên task đang chạy
  → `already_running` (không reset round controller của run đang sống).

---

## 9. Nợ đã ghi nhận (liên quan pipeline)

1. `supervisor-loop.js:36` — `initial` chưa định nghĩa trong `onEvent`
   (dùng làm fallback cho `selectAgent` khi round controller trả request mới).
2. `repair.request` queue + `repair-worker.js`/`repair-worker-production.js`
   còn tồn tại nhưng không còn trong luồng chính — repair đã chuyển về
   round-controller (`requestRepair`).
3. Sync contract `read_code`/`commit_changes` với schema tools
   (`schemas/agent/tools/*.schema.json`).

# Kế hoạch triển khai pipeline mới (New Pipeline)

> Ngày lập: 2026-09-11 · Owner duyệt toàn bộ đề xuất trong `de-xuat-moi.md`,
> chỉnh sửa: giữ `write_diff` (không xóa), `edit_file` → **`edit_diff`**,
> `write_diff` chỉ cho phép file **dưới 8 KB**.
> Trạng thái: **KẾ HOẠCH — chưa code** (design gate, chỉ thiết kế).

---

## 0. Mục tiêu & ràng buộc bất biến

### Mục tiêu

- Thống nhất về **Model B (session pipeline)**: 1 session agentic làm trọn bài,
  attempt 2+ là repair với failure context — bỏ mô hình R1→R3 dắt tay thin agent.
- Giảm chi phí token chiều ghi: file lớn sửa cục bộ không còn gửi full content.
- Sửa 3 khoảng hở đã phát hiện: bridge terminal, dispatchSprint DAG, 2 đường
  sprint orchestration.

### Ràng buộc không được phá (giữ nguyên mọi PR)

- Không lộ/không persist plaintext credential (`credential_ref` duy nhất trong
  secret storage; không vào queue payload, persistence, log, terminal, HTTP response).
- Claude gateway env: `ANTHROPIC_BASE_URL`=gateway, `ANTHROPIC_AUTH_TOKEN`=credential,
  `ANTHROPIC_API_KEY=""`.
- Built-in SDK tools hard-block (`tools:[]` + Forge allowlist); agent chỉ gọi Forge tools.
- Checksum guard không được nới lỏng để cho test qua.
- Dùng project log service hiện có; không reintroduce fixed-agent/auto-created-agent.
- Unit test dùng mock; gateway thật chỉ ở smoke test. Không kill API của user
  (user bấm `r` để restart).
- Filesystem = source of truth; Index = cache; crash không hỏng project.

### Chỉnh sửa Owner duyệt riêng cho tool contract

| Quyết định | Chi tiết |
|---|---|
| Giữ `write_diff` | Không xóa; thêm guard kích thước |
| `edit_file` → `edit_diff` | Tên tool mới là `edit_diff` |
| `write_diff` cap 8 KB | Vượt 8 KB → `CONTENT_TOO_LARGE` + gợi ý dùng `edit_diff` (file đã tồn tại) hoặc chia nhỏ |

---

## 1. Tổng quan kiến trúc đích

```
                    ┌─────────────────────────────────────────┐
                    │         Governance / Orchestration      │
                    │  Owner Chat · Sprint Upload · Dashboard │
                    │  ticketStatusStore · roadmapStore       │
                    └──────────────────┬──────────────────────┘
                                       │ submitTicket
                    ┌──────────────────▼──────────────────────┐
                    │         Supervisor (hub)                │
                    │  8-state machine · attempt builder      │
                    │  protocol-storage (audit)               │
                    └──────┬──────────────┬─────────┬─────────┘
                           │              │         │
              ┌────────────▼──┐  ┌───────▼────┐ ┌──▼────────┐
              │ Session Runner│  │ Change-set │ │ Verifier  │
              │ (agent loop)  │  │ Collector  │ │           │
              └───────┬───────┘  └───────┬────┘ └──┬────────┘
                      │                  │         │
                      └────────► git diff/status ─┘
                                 Node verify
                                         │
                              terminal bridge
                                         │
                              ticketStatusStore
                              task-summary / memory
```

- **State machine:** 12 → **8** (bỏ `MATERIALIZING`, gộp `REQUESTING`+`WAITING_AGENT`→`RUNNING`,
  gộp `WAITING_REPAIR`→`REPAIRING`).
- **Round:** Phase (R1 task / R2 planning / R3 code) → **Attempt** (attempt 1 = làm trọn bài,
  attempt 2+ = repair).
- **Worker/Queue:** 4 → **3** (`agent.request`, `collector.request`, `verification.request`);
  xóa `repair.request` + repair worker.
- **Protocol storage:** giữ, đổi vai từ "hợp đồng điều phối" sang "bằng chứng audit";
  ref `task/{id}/round_{n}/...` giữ nguyên format (round = attempt).
- **Plan gate:** bắt buộc R2 → **optional** qua `human-decision-service`.
- **Verification:** Node vẫn là nguồn sự thật PASS/FAIL (không đổi).

---

## 2. State machine mới (8 trạng thái)

### 2.1 Danh sách & chuyển

```text
CREATED → PREPARING → READY → RUNNING → VERIFYING → COMPLETED
                              ↘ REPAIRING ──────────┘
                              → FAILED
                              → NEEDS_HUMAN_REVIEW  (từ RUNNING hoặc REPAIRING)
```

`ALLOWED_TRANSITIONS` mới:

```js
CREATED:             [PREPARING, RUNNING, FAILED]
PREPARING:           [READY, FAILED]
READY:               [RUNNING, FAILED]
RUNNING:             [VERIFYING, REPAIRING, NEEDS_HUMAN_REVIEW, FAILED]
VERIFYING:           [COMPLETED, REPAIRING, FAILED]
REPAIRING:           [RUNNING, NEEDS_HUMAN_REVIEW, FAILED]
COMPLETED:           []
FAILED:              []
NEEDS_HUMAN_REVIEW:  []
```

`reset()` chỉ cho phép từ terminal (`COMPLETED`/`FAILED`/`NEEDS_HUMAN_REVIEW`) → `CREATED`
(giữ nguyên).

### 2.2 Sửa trong code

| File | Việc |
|---|---|
| `backend/src/modules/supervisor/supervisor-runtime.js` | `SUPERVISOR_STATES` 12→8; `ALLOWED_TRANSITIONS` mới; `prepare()` guard list cập nhật; `compactContext` giữ nguyên |
| `backend/src/modules/supervisor/supervisor-loop.js` | `start()` transition `REQUESTING`→`RUNNING`; `WAITING_AGENT`→`RUNNING`; bỏ nhánh `material_verification.*` cũ, thay bằng collector/verifier flow (mục 3); fix bug `initial` (supervisor-loop.js:36) nhân tiện |
| `backend/src/modules/supervisor/production-runtime.js` | `recover()` resume list đổi sang `CREATED`/`RUNNING`/`READY`/`REPAIRING`; `startTaskExclusive` resume guard đổi tương ứng |

### 2.3 Tương thích

- State cũ còn nằm trong `.forge/runtime/supervisors/*.json`: migration đọc state cũ,
  map `REQUESTING`/`WAITING_AGENT`→`RUNNING`, `MATERIALIZING`→`VERIFYING`,
  `WAITING_REPAIR`→`REPAIRING`; `repair.request` queue còn sót thì drain bỏ.
- Không đụng `TICKET_STATUSES` (vòng đời ticket độc lập).

---

## 3. Workers & queues mới

### 3.1 Session Runner (thay Sender Worker)

| Thuộc tính | Cũ (Sender) | Mới (Session Runner) |
|---|---|---|
| Queue | `agent.request` (giữ tên) | `agent.request` (giữ tên, không đổi consumer) |
| Adapter | `runAgentTurns` phân biệt `RESPONSE_FUNCTION_TOOLS` vs Forge tools (max_turns 8) | Một session agentic duy nhất qua `agentGateway.request` (adapter codex/claude/openai), emit `session.result` |
| Response tools | `code_needed`/`planning`/`submit_code_response`/`patch_repair_response`… | **Xóa hết** — agent tự quyết trong session |
| Tool loop | `toolsForRequest` theo `expected_output` + capabilities | `attemptContextBuilder` build prompt 3 tầng (mục 7); capability list mới gồm `edit_diff` + `read_file` offset/limit |
| Event publish | `agent.response.received` / `agent.response.failed` | `session.completed` / `session.failed` (hoặc giữ tên cũ để không churn bus — quyết ở implement; mặc định **giữ tên** để bus không đổi) |
| Dedupe | `processedStore` + `processed: Map` | Giữ nguyên |

**File:** `backend/src/modules/supervisor/sender-worker.js` → refactor thành session runner
(giữ export `createSenderWorker` để không churn import, hoặc alias `createSessionRunner`).

### 3.2 Change-set Collector (thay Materializer Worker)

| Thuộc tính | Cũ | Mới |
|---|---|---|
| Queue | `materializer.request` | `collector.request` (đổi tên; migration alias `materializer.request`→`collector.request` 1 phiên bản) |
| Việc | 4 gate `structure_ok`/`checksum_ok`/`anchor_ok`/`dry_apply_ok` + apply patch | `git status --porcelain` + `git diff --name-only` + checksum file sau session; publish `{ changed_paths, checksums, diff_stat }` |
| Publish | `material_verification.completed` / `material_verification.invalid` | `changeset.collected` (payload: `{ changed_paths, checksums, empty: boolean }`) |
| Kích thước | ~359 dòng | ~60–80 dòng |

**File:** `backend/src/modules/supervisor/materializer-worker.js` → `collector-worker.js`
(hoặc đổi tên trong cùng file, giữ export cũ 1 phiên bản với deprecation).

**Vì sao tách riêng (không gộp vào Session Runner):** queue là điểm recovery —
session tốn tiền; crash sau session mà chưa verify thì collector job còn trên durable queue.

### 3.3 Verifier (giữ nguyên vai)

- Input đổi: thay vì `valid_patches`, nhận `changeset` từ collector.
- Dùng `verificationOrchestrator` / `check-runner` hiện có để chạy authoritative check
  trên `changed_paths` thực tế (không còn patch để verify).
- Publish `verification.passed` / `verification.failed` giữ nguyên — Supervisor loop
  không đổi nhánh này.

**File:** `backend/src/modules/supervisor/verification-worker.js` — chỉnh input shape.

### 3.4 Xóa

- `backend/src/modules/supervisor/repair-worker.js`
- `backend/src/modules/supervisor/repair-worker-production.js`
- `repair.request` queue
- `RESPONSE_FUNCTION_TOOLS` set, `stage1AgentTools` filter trong sender-worker
- Phần lớn `round-controller.js` (R1→R3, `validatePlan`, `assertFullContext`) →
  thu về `attempt-context-builder.js` (~50 dòng, mục 4).

### 3.5 Production wiring

**File:** `backend/src/modules/supervisor/production-runtime.js`

- `QUEUE_NAMES`: `["agent.request","sender.handoff","collector.request","verification.request"]`
  (bỏ `materializer.request`, `repair.request`; giữ `sender.handoff` nếu còn dùng cho fast path).
- `createSupervisorLoop` nhận `collectorQueue` thay vì `materializerQueue`.
- `createQueuePoller` cho collector + verifier (thay materializer loop).
- `repairWorker = null` giữ nguyên (đã null).
- `eventBus.subscribe` filter giữ nguyên.

---

## 4. Attempt context builder (thay round-controller)

**File mới:** `backend/src/modules/supervisor/attempt-context-builder.js`
(thay `round-controller.js`; giữ file cũ 1 phiên bản với re-export deprecated hoặc xóa sau 1 release).

```js
export function createAttemptContextBuilder({ conversationStateStore, protocolStorage, codeIndexSummaryBuilder, memoryRetriever, ... } = {}) {
  return { buildAttemptRequest, buildRepairRequest };
}
```

| Attempt | Nội dung |
|---|---|
| 1 | Ticket (title/objective/acceptance) + context pack (index summary + relevant files) + project memory facts (L2) + conventions. 3 tầng payload (mục 7). |
| 2+ | Giữ nguyên tầng 1+2 từ attempt trước (để hit prefix cache) + **append** failure context cuối: verifier output + `git diff` hiện tại + correction text. Không chèn giữa. |

- Persist request vào protocol storage trước enqueue (như round-controller cũ).
- `context_revision` / `context_checksums` từ `conversationStateStore` để làm cache-validity.
- `in_window` / transcript block logic thu gọn: attempt blocks append-only, không còn R2-repeat edge case.

---

## 5. Protocol storage — giữ, đổi vai

- Giữ **nguyên** `protocol-storage.js` + ref phẳng `task/{id}/round_{n}/request|response`
  + checksum `.meta.json`.
- Đổi vai: từ "hợp đồng điều phối" (Node đọc để rebuild context round kế) sang
  **"bằng chứng audit"** (prompt gửi vào, response cuối, tool exchange).
- Bắt buộc: request pack + final response. Tool exchange best-effort.
- `round = attempt` (giữ format, tránh churn).

Không đụng `conversation-state-store.js` (đã có sẵn `prompt_cache_key`,
`context_revision`, `context_checksums`, `last_provider_response_id`, `parent_request_id`
cho mục 7).

---

## 6. Bridge terminal → ticket status + memory (ưu tiên cao)

### 6.1 Ticket status bridge

**Vị trí:** `backend/scripts/start-control-api.mjs` (hoặc `production-runtime.js` —
chọn 1 chỗ, mặc định `start-control-api.mjs` vì đã có `ticketStatusStore`/`roadmaps`).

Subscribe execution `eventBus`:

| Supervisor terminal | Ticket transition |
|---|---|
| `task.completed` (`verification.passed` → `COMPLETED`) | `running`/`reviewing` → `done` |
| `task.failed` (`agent.response.failed` hoặc `verification` fail hết attempt) | `running`/`reviewing` → `failed` |
| `NEEDS_HUMAN_REVIEW` | `running`/`reviewing` → `needs_human_review` |

Đồng bộ cả hai nơi: `ticketStatusStore.updateStatus` + `roadmaps.updateTicketStatus`
(để dashboard thấy). Dùng cùng `request_id`/`correlation_id` để idempotent.

### 6.2 Terminal hook ghi memory

Cùng subscriber trên, sau khi update ticket xong:

```
task.completed → build summary từ session (tool_events + git diff stat)
              → facts = filter(summary.facts, isLongTermFact)  // giữ regex hiện có
              → taskSummaryStore.build(taskId) → projectMemoryStore.build(projectId)
```

→ Memory mới có nguồn sống (hiện chỉ có đường stage1 cũ ghi).

### 6.3 DAG dispatchSprint

**File:** `backend/scripts/start-control-api.mjs:129` (`dispatchSprint`)

- Thay `Promise.all(tickets.map(dispatchTask))` bằng topological sort theo
  `ticket.dependencies` (Kahn hoặc DFS).
- Dispatch từng tầng (level) tuần tự; mỗi ticket chờ terminal (`task.completed`/
  `task.failed`) rồi mới dispatch tầng kế.
- Gate bằng `ticketStatusStore.dependenciesReady(ticketId)` trước khi dispatch
  từng ticket (đã có sẵn, chỉ chưa được dùng).
- Ticket `blocked` → không dispatch, chờ dependency `done` rồi retry.

### 6.4 Consolidate 2 đường sprint

- Đặt tên rõ: `sprint-plan-generation` (SprintOrchestrationService 4 roles) vs
  `sprint-execution` (dispatchSprint supervisor pipeline).
- Không gộp code trong phase này — chỉ đổi tên/log để UI không nhầm đường.

---

## 7. Cache — 3 tầng payload

### 7.1 Nguyên lý

HTTP LLM API stateless: client **luôn** gửi lại toàn bộ context. Prefix cache
không giảm băng thông mà giảm **chi phí token + TTFT**. Server match cache bằng
*nội dung prefix*, nên gửi lại chính là cách tìm cache. Muốn gửi delta thật sự
chỉ có OpenAI Responses `store:true` + `previous_response_id` (đã có chỗ cắm
`last_provider_response_id` trong conversation-state-store, đang ngủ).

### 7.2 3 tầng payload cho Session Runner

```text
Tầng 1  system + conventions + project memory   ← byte-identical QUA CÁC TICKET
        → breakpoint cuối tầng này
Tầng 2  ticket + context pack (checksum index)  ← byte-identical TRONG attempt
        → breakpoint cuối: repair attempt sau vẫn hit tầng 1+2
Tầng 3  tool results + correction text          ← luôn append CUỐI, không chèn giữa
```

- Project memory (L2) chính là tầng 1 của cache — block ổn định nhất, đặt đầu prompt.
- Repair cũ nhét errors vào block giữa → phá cache; mới correction luôn append cuối.
- `context_checksums` / `context_revision` làm cache-validity: index đổi → đổi
  `prompt_cache_key`.

### 7.3 Marker theo provider

| Provider | Marker |
|---|---|
| Anthropic / Claude | block `cacheable` → `cache_control: {type:"ephemeral"}` (`request-builder.js`) |
| OpenAI / Codex | `cache_config` → `prompt_cache_key` + developer block `prompt_cache_breakpoint` (`openai-request-builder.js`) |

Đường session mới hiện không set gì → **cache = 0** trên Claude raw, auto-cache
mờ nhạt trên OpenAI. Phải đánh marker đủ cả 2 path sau khi xếp 3 tầng.

### 7.4 Đo trước khi tối ưu

- Ghi `usage.cache_read_input_tokens` / `cache_creation_input_tokens`
  (đã normalize trong `mapUsage`) vào project log mỗi attempt.
- Chưa có dashboard thì log ra `projectLogger` là đủ để thấy hit-rate thật.

### 7.5 Probe `previous_response_id` (thí nghiệm, không chặn pipeline)

- Chỉ cho Codex/OpenAI path, **opt-in theo profile** (`profile.use_previous_response_id`).
- Probe qua `sv.devquote.shop`: gửi `store:true` + `previous_response_id` thử;
  fallback full-resend nếu gateway strip.
- Lưu ý retention provider (~30 ngày) — copy thứ 2 ngoài `.forge`.

---

## 8. Nhớ — 4 lớp

```text
L0 trong-session:  transcript append-only
L1 task pack:      index.db + structural summary + ticket + plan
L2 project memory: conventions + past decisions + facts (regex filter giữ nguyên)
L3 codebase truth: search_code/read_code + code index (tool call, không inject)
```

| Việc | Mô tả | Ưu tiên |
|---|---|---|
| Terminal hook ghi memory | Mục 6.2 | **P0** (đi kèm bridge) |
| Retriever scoring | `memory-retriever.js`: AND-substring → scoring (term match + recency + domain), top ~20, cap prompt | P1 |
| Decay | Fact lâu không hit → archival | P2 |

- L2 facts inject vào **tầng 1** của 3 tầng payload (ổn định nhất).
- Knowledge/decisions stores đã wiring nhưng chưa inject — P1 mới đưa vào L2.

---

## 9. Tool contract v2 — `edit_diff` + `read_file` offset/limit + `write_diff` 8 KB cap

### 9.1 Tổng quan 3 mức theo kích thước thay đổi

```text
file mới hoặc <8 KB            → write_diff (full content)
file ≥8 KB, sửa cục bộ         → read_file {offset,limit} quanh vị trí → edit_diff {anchor}
sửa rải rác nhiều chỗ           → nhiều edit_diff (mỗi cái 1 anchor)
```

### 9.2 `edit_diff` (mới)

**Schema:** `schemas/agent/tools/edit-diff.schema.json`

```json
{
  "title": "Forge edit diff tool input",
  "type": "object",
  "additionalProperties": false,
  "required": ["path", "before_checksum", "anchor", "replacement"],
  "properties": {
    "path": { "type": "string", "minLength": 1, "pattern": "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+" },
    "before_checksum": { "type": ["string","null"], "pattern": "^sha256:[a-fA-F0-9]{64}$" },
    "anchor": { "type": "string", "minLength": 1 },
    "replacement": { "type": "string" },
    "occurrence": { "type": "string", "enum": ["first","all"], "default": "first" }
  }
}
```

**Behavior** (`backend/src/tools/agent-lifecycle-tools.js` — thêm `createEditDiffTool`):

```
read current content (fileService.readFile)
→ verify before_checksum (giữ nguyên guard như write_diff)
→ tìm anchor (exact string match)
  → không tìm thấy → ANCHOR_NOT_FOUND
  → tìm thấy >1 với occurrence=first → ANCHOR_NOT_UNIQUE (bắt agent thu hẹp anchor)
  → occurrence=all → replace tất cả
→ replace → atomicWrite
→ trả về { path, sha256: newChecksum, replaced_count }
```

- Governance: `safePath` + `assertAllowed` y như `write_diff`.
- `MAX_CONTENT` cho `anchor`+`replacement` cộng lại ≤ 200KB (giữ cap hiện có).
- Không cần `allowed_file_paths` mới — dùng chung với `write_diff`.

**Registry:** `backend/src/tools/index.js` — thêm `editDiffDefinition` + `lifecycle.edit_diff`.

**MCP bridge:** `backend/src/tools/claude-sdk-forge-tools.js` — thêm `edit_diff` vào tool list
(Claude SDK path).

**Capability:** thêm `"edit_diff"` vào `capabilitiesForRound` / `createExecutionContext`
và `nodeforge-task-integration.js` capability list.

### 9.3 `read_file` offset/limit (mở rộng, không phá contract)

**Schema:** `schemas/agent/tools/read-file.schema.json` — thêm optional:

```json
"offset": { "type": "integer", "minimum": 1, "description": "1-based start line, inclusive" },
"limit":  { "type": "integer", "minimum": 1, "maximum": 500, "description": "max lines to return" }
```

- Không có offset/limit → behavior cũ (trả full, slice 200KB).
- Có offset/limit → `lines.slice(offset-1, offset-1+limit).join("\n")`, trả kèm
  `offset`, `limit`, `total_lines`, `truncated`.
- `sha256` vẫn là hash của **toàn file** (để `before_checksum` cho `edit_diff`/`write_diff`
  dùng), không phải hash của slice.

**File:** `backend/src/tools/agent-lifecycle-tools.js` — `createReadFileTool` nhận thêm
`offset`/`limit` từ input.

### 9.4 `write_diff` 8 KB cap

**File:** `backend/src/tools/agent-lifecycle-tools.js` — `createWriteDiffTool`

```js
const WRITE_DIFF_MAX_BYTES = 8192; // 8 KB — Owner duyệt
// trong execute, sau safePath/assertAllowed:
const byteLength = Buffer.byteLength(input.content, "utf8");
if (byteLength > WRITE_DIFF_MAX_BYTES) {
  throw error("CONTENT_TOO_LARGE",
    `write_diff content is ${byteLength} bytes, limit is ${WRITE_DIFF_MAX_BYTES}. ` +
    `For existing files use edit_diff with an anchor; for new files split into smaller writes.`,
    { byte_length: byteLength, limit: WRITE_DIFF_MAX_BYTES });
}
```

- File **mới** (`current === null`) vượt 8 KB cũng bị chặn — agent phải chia nhỏ
  (nhiều `write_diff` cho file mới lớn không khả thi trong 1 lần; thực tế file mới
  lớn hiếm — nếu gặp, agent tạo file rỗng rồi `edit_diff` append, hoặc Node nới cap
  theo ticket).
- Error code `CONTENT_TOO_LARGE` để agent tự retry bằng `edit_diff`.
- `MAX_CONTENT` (200KB) giữ nguyên cho `edit_diff` anchor/replacement — chỉ `write_diff`
  bị siết 8 KB.

**Schema:** `schemas/agent/tools/write-diff.schema.json` — không cần thêm field;
cap là runtime guard (không đưa vào JSON schema để không phải version schema).

### 9.5 Prompt hướng dẫn Session Runner

Đưa vào system prompt của attempt:

```text
File write rules:
- New file or file <8 KB: use write_diff with full content.
- Existing file ≥8 KB, local change: read_file {offset,limit} around the target,
  then edit_diff {anchor, replacement}. Anchor must be unique exact string.
- Multiple scattered changes: multiple edit_diff calls.
- write_diff over 8 KB will be rejected with CONTENT_TOO_LARGE — retry with edit_diff.
```

### 9.6 Tương thích & migration

- Ticket cũ đang chạy dở với `write_diff` full content >8 KB: sẽ nhận
  `CONTENT_TOO_LARGE` ở attempt kế → agent tự chuyển `edit_diff` (không cần migrate data).
- Test cũ mock `write_diff` với content nhỏ (<8 KB) không ảnh hưởng.

---

## 10. Thứ tự thực hiện (6 phase)

| Phase | Việc | File chính | Phụ thuộc |
|---|---|---|---|
| **1** | Bridge terminal → ticket status + terminal hook ghi memory + đo cache hit-rate | `start-control-api.mjs`, `task-summary-store.js`, `project-memory-store.js` | Không |
| **2** | State machine 12→8 + Session Runner + Collector + Verifier + attempt-context-builder | `supervisor-runtime.js`, `supervisor-loop.js`, `sender-worker.js`, `materializer-worker.js`, `verification-worker.js`, `production-runtime.js`, `attempt-context-builder.js` (mới) | Phase 1 (bridge là nền cho terminal mới) |
| **3** | 3 tầng payload + marker cache (Anthropic + OpenAI) | `attempt-context-builder.js`, `request-builder.js`, `openai-request-builder.js` | Phase 2 |
| **4** | Tool contract v2: `edit_diff` + `read_file` offset/limit + `write_diff` 8KB cap | `agent-lifecycle-tools.js`, `tools/index.js`, `claude-sdk-forge-tools.js`, `schemas/agent/tools/*.json`, `production-runtime.js` (capabilities) | Độc lập, có thể song song với Phase 2 |
| **5** | Probe `previous_response_id` (thí nghiệm) | `codex-adapter.js`/`openai-adapter.js`, `conversation-state-store.js` | Phase 3 |
| **6** | dispatchSprint DAG + consolidate sprint paths | `start-control-api.mjs` | Phase 1 |

Phase 4 có thể làm song song với Phase 2 vì không đụng state machine.

---

## 11. Kiểm thử

### Unit (mock, không gọi gateway thật)

| Test | Cover |
|---|---|
| `supervisor-runtime.test.js` | 8-state transitions, invalid transition = ConfigurationError, migration map cũ→mới |
| `supervisor-loop.test.js` | `RUNNING`→`VERIFYING`→`COMPLETED`, `RUNNING`→`REPAIRING`→`RUNNING`, `NEEDS_HUMAN_REVIEW` |
| `attempt-context-builder.test.js` (mới) | attempt 1 build, attempt 2+ append correction cuối, protocol persist |
| `edit-diff.test.js` (mới) | anchor unique → success, not found → ANCHOR_NOT_FOUND, duplicate → ANCHOR_NOT_UNIQUE, checksum mismatch → CHECKSUM_MISMATCH, PATH_FORBIDDEN |
| `read-file-offset.test.js` (mới) | offset/limit slice, sha vẫn hash full file, total_lines/truncated |
| `write-diff-cap.test.js` (mới) | ≤8KB pass, >8KB CONTENT_TOO_LARGE, error message gợi ý edit_diff |
| `terminal-bridge.test.js` (mới) | task.completed→ticket done, task.failed→failed, idempotent với duplicate event |
| `dispatch-dag.test.js` (mới) | topological sort, dependenciesReady gate, blocked→pending khi dependency done |
| `cache-marker.test.js` (mới) | 3 tầng payload → marker đúng vị trí Anthropic + OpenAI |

### Regression (giữ xanh)

- `supervisor-execution.test.js`, `sender-worker-tool-loop.test.js`,
  `codex-forge-tool-loop.test.js`, `runtime-tool-governance.test.js`,
  `terminal-tool-bridge.test.js`, `openai-sdk-supervisor-hello.test.js`

### Lint & schema

- `pnpm lint`, `pnpm typecheck`, `pnpm validate:schemas` (sau khi thêm `edit-diff.schema.json`
  và mở rộng `read-file.schema.json`).

### Smoke thủ công (không commit, user bấm `r` để restart API)

1. Tạo ticket nhỏ với file <8KB → `write_diff` pass.
2. Tạo ticket sửa file lớn (>8KB) → `write_diff` trả `CONTENT_TOO_LARGE` → agent tự
   `read_file {offset,limit}` + `edit_diff` → pass.
3. `read_file {offset: 50, limit: 20}` → slice đúng, sha là hash full file.
4. Ticket fail verification → repair attempt 2 với correction append cuối → pass.
5. Sprint 3 tickets có dependencies A→B→C → dispatch theo DAG, B chờ A done.
6. Check `.forge/runtime/nf/logs/node.log` không chứa plaintext credential;
   `forge.tool_*` events có `edit_diff` + `cache_read_input_tokens`.

---

## 12. Rủi ro & giảm thiểu

| Rủi ro | Giảm thiểu |
|---|---|
| `write_diff` 8KB cap làm ticket tạo file mới lớn bị kẹt | Hiếm (file mới lớn thường là scaffold — agent tạo file rỗng rồi `edit_diff` append). Nếu gặp, Node có thể nới cap theo ticket `allowed_file_paths` (follow-up). |
| `edit_diff` anchor không unique → agent loop | Error `ANCHOR_NOT_UNIQUE` kèm hint "include more surrounding lines"; prompt hướng dẫn anchor nên dài 3–5 dòng. |
| Gateway strip `previous_response_id` (như từng strip `tools`) | Phase 5 là probe, fallback full-resend luôn sẵn; opt-in theo profile. |
| State migration cũ→mới làm resume sai | Migration map explicit trong `supervisor-runtime.js`; test cover `REQUESTING`/`WAITING_AGENT`→`RUNNING`. |
| Collector `git diff` miss file chưa tracked | Dùng `git status --porcelain` (bao gồm `??` untracked) + `git diff --cached` nếu cần. |

---

## 13. Ngoài phạm vi phase này

- Không cài `@openai/codex` CLI, không sửa MCP bridge/session.
- Không đụng `ARCHITECTURE.md` (cập nhật sau khi pipeline mới ổn).
- Không đổi `claude-sdk-forge-tools.js` ngoài thêm `edit_diff`.
- Không commit/push tự động — Owner duyệt từng phase mới code.

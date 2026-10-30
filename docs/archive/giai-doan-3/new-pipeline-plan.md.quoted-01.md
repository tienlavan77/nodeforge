<!-- Preserves a quoted historical document section so engineers can read archived examples without treating them as new executable definitions; removing quote prefixes reconstructs the exact original bytes. -->
> # Kế hoạch triển khai pipeline mới (New Pipeline)
> 
> > Ngày lập: 2026-09-11 · Owner duyệt toàn bộ đề xuất trong `de-xuat-moi.md`,
> > chỉnh sửa: giữ `write_diff` (không xóa), `edit_file` → **`edit_diff`**,
> > `write_diff` chỉ cho phép file **dưới 8 KB**.
> > Trạng thái: **KẾ HOẠCH — chưa code** (design gate, chỉ thiết kế).
> 
> ---
> 
> ## 0. Mục tiêu & ràng buộc bất biến
> 
> ### Mục tiêu
> 
> - Thống nhất về **Model B (session pipeline)**: 1 session agentic làm trọn bài,
>   attempt 2+ là repair với failure context — bỏ mô hình R1→R3 dắt tay thin agent.
> - Giảm chi phí token chiều ghi: file lớn sửa cục bộ không còn gửi full content.
> - Sửa 3 khoảng hở đã phát hiện: bridge terminal, dispatchSprint DAG, 2 đường
>   sprint orchestration.
> 
> ### Ràng buộc không được phá (giữ nguyên mọi PR)
> 
> - Không lộ/không persist plaintext credential (`credential_ref` duy nhất trong
>   secret storage; không vào queue payload, persistence, log, terminal, HTTP response).
> - Claude gateway env: `ANTHROPIC_BASE_URL`=gateway, `ANTHROPIC_AUTH_TOKEN`=credential,
>   `ANTHROPIC_API_KEY=""`.
> - Built-in SDK tools hard-block (`tools:[]` + Forge allowlist); agent chỉ gọi Forge tools.
> - Checksum guard không được nới lỏng để cho test qua.
> - Dùng project log service hiện có; không reintroduce fixed-agent/auto-created-agent.
> - Unit test dùng mock; gateway thật chỉ ở smoke test. Không kill API của user
>   (user bấm `r` để restart).
> - Filesystem = source of truth; Index = cache; crash không hỏng project.
> 
> ### Chỉnh sửa Owner duyệt riêng cho tool contract
> 
> | Quyết định | Chi tiết |
> |---|---|
> | Giữ `write_diff` | Không xóa; thêm guard kích thước |
> | `edit_file` → `edit_diff` | Tên tool mới là `edit_diff` |
> | `write_diff` cap 8 KB | Vượt 8 KB → `CONTENT_TOO_LARGE` + gợi ý dùng `edit_diff` (file đã tồn tại) hoặc chia nhỏ |
> 
> ---
> 
> ## 1. Tổng quan kiến trúc đích
> 
> ```
>                     ┌─────────────────────────────────────────┐
>                     │         Governance / Orchestration      │
>                     │  Owner Chat · Sprint Upload · Dashboard │
>                     │  ticketStatusStore · roadmapStore       │
>                     └──────────────────┬──────────────────────┘
>                                        │ submitTicket
>                     ┌──────────────────▼──────────────────────┐
>                     │         Supervisor (hub)                │
>                     │  8-state machine · attempt builder      │
>                     │  protocol-storage (audit)               │
>                     └──────┬──────────────┬─────────┬─────────┘
>                            │              │         │
>               ┌────────────▼──┐  ┌───────▼────┐ ┌──▼────────┐
>               │ Session Runner│  │ Change-set │ │ Verifier  │
>               │ (agent loop)  │  │ Collector  │ │           │
>               └───────┬───────┘  └───────┬────┘ └──┬────────┘
>                       │                  │         │
>                       └────────► git diff/status ─┘
>                                  Node verify
>                                          │
>                               terminal bridge
>                                          │
>                               ticketStatusStore
>                               task-summary / memory
> ```
> 
> - **State machine:** 12 → **8** (bỏ `MATERIALIZING`, gộp `REQUESTING`+`WAITING_AGENT`→`RUNNING`,
>   gộp `WAITING_REPAIR`→`REPAIRING`).
> - **Round:** Phase (R1 task / R2 planning / R3 code) → **Attempt** (attempt 1 = làm trọn bài,
>   attempt 2+ = repair).
> - **Worker/Queue:** 4 → **3** (`agent.request`, `collector.request`, `verification.request`);
>   xóa `repair.request` + repair worker.
> - **Protocol storage:** giữ, đổi vai từ "hợp đồng điều phối" sang "bằng chứng audit";
>   ref `task/{id}/round_{n}/...` giữ nguyên format (round = attempt).
> - **Plan gate:** bắt buộc R2 → **optional** qua `human-decision-service`.
> - **Verification:** Node vẫn là nguồn sự thật PASS/FAIL (không đổi).
> 
> ---
> 
> ## 2. State machine mới (8 trạng thái)
> 
> ### 2.1 Danh sách & chuyển
> 
> ```text
> CREATED → PREPARING → READY → RUNNING → VERIFYING → COMPLETED
>                               ↘ REPAIRING ──────────┘
>                               → FAILED
>                               → NEEDS_HUMAN_REVIEW  (từ RUNNING hoặc REPAIRING)
> ```
> 
> `ALLOWED_TRANSITIONS` mới:
> 
> ```js
> CREATED:             [PREPARING, RUNNING, FAILED]
> PREPARING:           [READY, FAILED]
> READY:               [RUNNING, FAILED]
> RUNNING:             [VERIFYING, REPAIRING, NEEDS_HUMAN_REVIEW, FAILED]
> VERIFYING:           [COMPLETED, REPAIRING, FAILED]
> REPAIRING:           [RUNNING, NEEDS_HUMAN_REVIEW, FAILED]
> COMPLETED:           []
> FAILED:              []
> NEEDS_HUMAN_REVIEW:  []
> ```
> 
> `reset()` chỉ cho phép từ terminal (`COMPLETED`/`FAILED`/`NEEDS_HUMAN_REVIEW`) → `CREATED`
> (giữ nguyên).
> 
> ### 2.2 Sửa trong code
> 
> | File | Việc |
> |---|---|
> | `backend/src/modules/supervisor/supervisor-runtime.js` | `SUPERVISOR_STATES` 12→8; `ALLOWED_TRANSITIONS` mới; `prepare()` guard list cập nhật; `compactContext` giữ nguyên |
> | `backend/src/modules/supervisor/supervisor-loop.js` | `start()` transition `REQUESTING`→`RUNNING`; `WAITING_AGENT`→`RUNNING`; bỏ nhánh `material_verification.*` cũ, thay bằng collector/verifier flow (mục 3); fix bug `initial` (supervisor-loop.js:36) nhân tiện |
> | `backend/src/modules/supervisor/production-runtime.js` | `recover()` resume list đổi sang `CREATED`/`RUNNING`/`READY`/`REPAIRING`; `startTaskExclusive` resume guard đổi tương ứng |
> 
> ### 2.3 Tương thích
> 
> - State cũ còn nằm trong `.forge/runtime/supervisors/*.json`: migration đọc state cũ,
>   map `REQUESTING`/`WAITING_AGENT`→`RUNNING`, `MATERIALIZING`→`VERIFYING`,
>   `WAITING_REPAIR`→`REPAIRING`; `repair.request` queue còn sót thì drain bỏ.
> - Không đụng `TICKET_STATUSES` (vòng đời ticket độc lập).
> 
> ---
> 
> ## 3. Workers & queues mới
> 
> ### 3.1 Session Runner (thay Sender Worker)
> 
> | Thuộc tính | Cũ (Sender) | Mới (Session Runner) |
> |---|---|---|
> | Queue | `agent.request` (giữ tên) | `agent.request` (giữ tên, không đổi consumer) |
> | Adapter | `runAgentTurns` phân biệt `RESPONSE_FUNCTION_TOOLS` vs Forge tools (max_turns 8) | Một session agentic duy nhất qua `agentGateway.request` (adapter codex/claude/openai), emit `session.result` |
> | Response tools | `code_needed`/`planning`/`submit_code_response`/`patch_repair_response`… | **Xóa hết** — agent tự quyết trong session |
> | Tool loop | `toolsForRequest` theo `expected_output` + capabilities | `attemptContextBuilder` build prompt 3 tầng (mục 7); capability list mới gồm `edit_diff` + `read_file` offset/limit |
> | Event publish | `agent.response.received` / `agent.response.failed` | `session.completed` / `session.failed` (hoặc giữ tên cũ để không churn bus — quyết ở implement; mặc định **giữ tên** để bus không đổi) |
> | Dedupe | `processedStore` + `processed: Map` | Giữ nguyên |
> 
> **File:** `backend/src/modules/supervisor/sender-worker.js` → refactor thành session runner
> (giữ export `createSenderWorker` để không churn import, hoặc alias `createSessionRunner`).
> 
> ### 3.2 Change-set Collector (thay Materializer Worker)
> 
> | Thuộc tính | Cũ | Mới |
> |---|---|---|
> | Queue | `materializer.request` | `collector.request` (đổi tên; migration alias `materializer.request`→`collector.request` 1 phiên bản) |
> | Việc | 4 gate `structure_ok`/`checksum_ok`/`anchor_ok`/`dry_apply_ok` + apply patch | `git status --porcelain` + `git diff --name-only` + checksum file sau session; publish `{ changed_paths, checksums, diff_stat }` |
> | Publish | `material_verification.completed` / `material_verification.invalid` | `changeset.collected` (payload: `{ changed_paths, checksums, empty: boolean }`) |
> | Kích thước | ~359 dòng | ~60–80 dòng |
> 
> **File:** `backend/src/modules/supervisor/materializer-worker.js` → `collector-worker.js`
> (hoặc đổi tên trong cùng file, giữ export cũ 1 phiên bản với deprecation).
> 
> **Vì sao tách riêng (không gộp vào Session Runner):** queue là điểm recovery —
> session tốn tiền; crash sau session mà chưa verify thì collector job còn trên durable queue.
> 
> ### 3.3 Verifier (giữ nguyên vai)
> 
> - Input đổi: thay vì `valid_patches`, nhận `changeset` từ collector.
> - Dùng `verificationOrchestrator` / `check-runner` hiện có để chạy authoritative check
>   trên `changed_paths` thực tế (không còn patch để verify).
> - Publish `verification.passed` / `verification.failed` giữ nguyên — Supervisor loop
>   không đổi nhánh này.
> 
> **File:** `backend/src/modules/supervisor/verification-worker.js` — chỉnh input shape.
> 
> ### 3.4 Xóa
> 
> - `backend/src/modules/supervisor/repair-worker.js`
> - `backend/src/modules/supervisor/repair-worker-production.js`
> - `repair.request` queue
> - `RESPONSE_FUNCTION_TOOLS` set, `stage1AgentTools` filter trong sender-worker
> - Phần lớn `round-controller.js` (R1→R3, `validatePlan`, `assertFullContext`) →
>   thu về `attempt-context-builder.js` (~50 dòng, mục 4).
> 
> ### 3.5 Production wiring
> 
> **File:** `backend/src/modules/supervisor/production-runtime.js`
> 
> - `QUEUE_NAMES`: `["agent.request","sender.handoff","collector.request","verification.request"]`
>   (bỏ `materializer.request`, `repair.request`; giữ `sender.handoff` nếu còn dùng cho fast path).
> - `createSupervisorLoop` nhận `collectorQueue` thay vì `materializerQueue`.
> - `createQueuePoller` cho collector + verifier (thay materializer loop).
> - `repairWorker = null` giữ nguyên (đã null).
> - `eventBus.subscribe` filter giữ nguyên.
> 
> 
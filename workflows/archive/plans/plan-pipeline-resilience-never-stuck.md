<!-- Architecture plan: pipeline resilience — mọi error đều có automatic recovery trước khi escalate. -->
# Plan: Pipeline không dừng lỗi — automatic recovery cho Coder và Reviewer

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Pipeline hiện tại có **14+ error paths** dẫn đến dead-end (`task.failed` hoặc `needs_human_review`) mà không có automatic recovery. Khi Coder agent gặp provider crash/timeout → `agent.response.failed` → `task.failed` ngay lập tức. Khi Reviewer unavailable/failure → park → chờ human. Human phải can thiệp thủ công cho **mọi lỗi**, kể cả transient errors (network timeout, provider overload, temporary unavailability). Hệ quả: pipeline liên tục "kẹt", owner phải restart/resubmit liên tục.

- **Kết quả:** Mỗi error path trong pipeline đều có **automatic recovery strategy** trước khi escalate lên human. Transient errors (provider timeout, temporary unavailability) được auto-retry với budget hữu hạn. Persistent errors được phân loại: recoverable → retry/re-dispatch; non-recoverable → degrade gracefully (Gate OFF: continue + backlog; Gate ON: park có chủ đích). **Không có error path nào dẫn đến `task.failed` cứng mà chưa thử recovery.**

- **Giá trị:** Pipeline chạy trơn tru qua phần lớn lỗi vận hành thông thường. Owner chỉ cần can thiệp cho các blocker thực sự (scope conflict, security risk, contract ambiguity) — không phải cho mỗi lần provider tạm thời không khả dụng.

## 2. Phạm vi

### In scope

- **Coder error recovery layer:** Thêm automatic retry/re-dispatch cho `agent.response.failed`, `CODER_EVIDENCE_PENDING`, `AGENT_REPORT_MISSING`, và generic execution failures — trước khi emit `task.failed` (§3, O1).
- **Reviewer error recovery layer** (Gate ON): Auto-retry cho `review.prepare_failed`, `review.failed`, `review.unavailable`, `review_verdict_invalid` — trước khi park `needs_human_review` (§3, O2).
- **Retry budget và backoff strategy:** Định nghĩa budget (max retries, backoff interval, total timeout) cho mỗi loại error; budget exhausted → escalate có chủ đích, không retry vô hạn (§3, O3).
- **Checkpoint-based resume:** Khi agent crash mid-execution, resume từ last checkpoint thay vì restart từ đầu (§3, O4).
- **Graceful degradation:** Khi retry budget exhausted — Gate OFF: continue + label + follow-up; Gate ON: park `needs_human_review` kèm context đầy đủ cho owner triage (§3, O5).
- **Observability:** Mỗi recovery attempt được log với event riêng (`recovery.attempted`, `recovery.succeeded`, `recovery.exhausted`) để owner/audit track được tần suất lỗi và hiệu quả recovery (§3, O6).

### Out of scope

- Không thay đổi architecture pipeline (4-layer vs Master–SubAgent) — giữ nguyên Sprint Leader → Supervisor → Coder/Reviewer flow.
- Không thay đổi public contract của `task.failed`, `task.completed`, `task.needs_human_review` — chỉ thay đổi **khi nào** emit các events này (sau recovery attempt, không phải ngay lập tức).
- Không thay đổi verification/repair loop (đã hoạt động tốt: `verification.failed` → `REPAIRING` → `startRepairRound`).
- Không thay đổi rulebook agents (`coder/README.md`, `reviewer/README.md`, `supervisor.md`).
- Không sửa `.forge/`, không thay đổi storage contract, không thay đổi approval flow.
- Không implement Master–SubAgent pattern (plan riêng: `plan-master-subagent-execution.md`).

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc bắt buộc:**
  1. **Không retry vô hạn.** Mỗi error type có budget hữu hạn (max attempts, total timeout). Budget exhausted → escalate có chủ đích, không silent loop.
  2. **Phân biệt transient vs persistent.** Transient (network timeout, provider overload, temporary unavailability) → auto-retry. Persistent (invalid config, missing permission, contract conflict) → escalate ngay, không retry. **Auto-retry ≠ gửi lại nguyên xi cho logic errors.**
     - **Transient infrastructure errors** (provider timeout, network, rate limit): agent **chưa kịp trả response** vì provider chưa hồi đáp → retry = gửi lại cùng request → lần sau provider OK → agent code bình thường. Không gây loop vì agent chưa code gì cả ở attempt fail.
     - **Agent logic errors** (code sai, test fail, lint fail, build fail): agent **đã trả response** nhưng kết quả sai → **KHÔNG auto-retry**. Pipeline đã có **repair loop** (`verification.failed` → `startRepairRound` kèm findings/reason → attempt N+1 với context "Revise: Reason: X. Findings: Y") → agent biết sai ở đâu → sửa khác đi. Repair loop có budget `max_review_revisions` → không loop vô tận.
     - **Guardrail bổ sung:** Nếu cùng error code lặp lại ≥2 lần liên tiếp ở auto-retry → classify thành persistent → escalate ngay, không retry thêm (tránh trường hợp "transient" giả — ví dụ prompt quá dài luôn bị provider reject).
  3. **Checkpoint-based resume.** Agent crash mid-execution → resume từ last checkpoint (Coder evidence, review findings, verification state), không restart từ đầu.
  4. **Idempotent retry.** Retry không tạo duplicate work, duplicate events, hoặc duplicate tickets. Mỗi retry attempt có `attempt_id` riêng, dedupe theo `request_id + attempt_id`.
  5. **Gate semantics giữ nguyên.** Gate ON = blocking pre-integrate; Gate OFF = async post-integrate. Recovery layer hoạt động **trong** gate semantics, không bypass gate.
  6. **Re-verify source.** Mọi path/line/SHA trong §4 là evidence snapshot. SL **phải** đối chiếu lại source hiện tại trước khi chốt manifest.

- **Hướng đề xuất:** Thêm **recovery middleware** vào supervisor-loop và ticket-execution-failure — intercept error events trước khi emit terminal state, thử recovery theo strategy table (§3, O3), emit `recovery.*` events cho observability. Recovery layer là **thin wrapper**, không thay đổi core pipeline logic.

- **Error classification và recovery strategy (nguồn chân lý):**

  | Error type | Classification | Recovery strategy | Budget exhausted |
  | --- | --- | --- | --- |
  | `agent.response.failed` — **transient infra** (provider timeout/network/overload: error xảy ra **trước** khi agent trả response, agent chưa code gì) | Transient | Auto-retry với exponential backoff (2s, 4s, 8s). Retry = re-dispatch cùng request; lần sau provider OK → agent code bình thường. **Không loop vô tận vì:** (a) budget hữu hạn; (b) cùng error code lặp ≥2 lần → re-classify persistent → escalate; (c) khác repair loop — không re-send sau khi agent đã trả response sai | Budget exhausted hoặc cùng error lặp ≥2 lần → `task.failed` + owner retry |
  | `verification.failed` / `changeset.collected` empty (Coder code sai, test/lint fail) | Agent logic error | **KHÔNG auto-retry** — dùng **repair loop có hướng dẫn**: `startRepairRound` (supervisor-loop.js L129-141) gửi attempt N+1 kèm `reason`; prompt text chứa `failed_paths` vì payload verification không có `findings`; `review_findings` structured field rỗng (`[]`) → signal yếu hơn review repair. Loop risk trung bình. | `max_review_revisions` (default 2) exhausted → `review_revision_limit` → park có context |
  | `agent.response.failed` (provider unavailable) | Transient | Auto-retry với longer backoff (10s, 30s, 60s) | `task.failed` + owner retry |
  | `agent.response.failed` (agent crash mid-execution) | Recoverable | Resume từ last checkpoint — resume **inject thêm context diagnostic** (đã code đến đâu, checkpoint state) để attempt mới không lặp lại approach fail | `task.failed` + owner retry |
  | `CODER_EVIDENCE_PENDING` | Recoverable | Wait + re-check evidence (polling, max 3 attempts) — không re-dispatch Coder, chỉ re-check data | `task.failed` + context |
  | `AGENT_REPORT_MISSING` | Persistent | **Không retry** — Coder quên tool call → `task.failed` ngay | N/A |
  | `CODER_BLOCKED` | Persistent | **Không retry** — blocker cần owner decision → `needs_human_review` | N/A |
  | `COMMIT_APPROVAL_REJECTED` | Persistent | **Không retry** — owner rejected → `task.failed` | N/A |
  | `review.prepare_failed` (Gate ON) | Transient | Auto-retry prepare (max 2 attempts) | `needs_human_review` + context |
  | `review.failed` (provider error, Gate ON) | Transient | Auto-retry dispatch Reviewer (max 2 attempts, different provider nếu có) | `needs_human_review` + context |
  | `review.unavailable` (Gate ON) | Transient | Wait + re-check availability (max 3 attempts, 30s interval) | `needs_human_review` + context |
  | `review_verdict_invalid` (Gate ON) | Recoverable | Re-dispatch Reviewer với stricter prompt (max 1 retry) | `needs_human_review` + context |
  | `review_revision_limit` (Gate ON) | Persistent | **Không retry** — exhausted budget → `needs_human_review` | N/A |
  | Generic execution failure (no checkpoint) | Persistent | **Không retry** — `task.failed` ngay | N/A |

- **Phân quyền:** Architecture khóa error classification, recovery strategy table, và budget constraints. SL quyết chi tiết delivery: số/tên ticket, file thực tế, tiêu chí chi tiết, thứ tự implement.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `supervisor/supervisor-loop.js` | Event handler chính; L125 `agent.response.failed` → `task.failed` | sha256:8e2bd77e…; chắc chắn cao |
| `supervisor/ticket-execution-failure.js` | Handler cho execution failures; `handleTicketExecutionFailure` | sha256:ccadc998…; chắc chắn cao |
| `supervisor/ticket-coder-completion.js` | Completion flow; L62 `CODER_EVIDENCE_PENDING` → `task.failed` | sha256:28cca409…; chắc chắn cao |
| `supervisor/ticket-resume.js` | Resume từ checkpoint (đã tồn tại, cần tái dụng) | Evidence snapshot; SL re-verify |
| `supervisor/coder-evidence-resume.js` | Resume Coder evidence (đã tồn tại) | Evidence snapshot; SL re-verify |
| `supervisor/review-revision-resume.js` | Resume review phase (đã tồn tại) | Evidence snapshot; SL re-verify |
| `supervisor/recovery-evidence.js` | Recovery evidence store (đã tồn tại) | Evidence snapshot; SL re-verify |
| `supervisor/durable-queue.js` | Queue với persistence (đã tồn tại, retry semantics) | Evidence snapshot; SL re-verify |
| `shared/errors.js` | Error codes và classification | Evidence snapshot; SL re-verify |
| `workflows/plan-reviewer-coder-collaboration.md` | Reviewer state matrix (O3 đã cover review errors) | sha256:a0dc0993…; kế thừa |

Các khu vực là định hướng discovery, không phải allowlist file bất biến. **SL xác minh đường thực tế trước khi chốt manifest (Guardrail 6, bắt buộc).**

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Coder transient errors có auto-retry | `agent.response.failed` (timeout/network/unavailable) → auto-retry với backoff, emit `recovery.attempted` + `recovery.succeeded`/`recovery.exhausted`. Budget exhausted → `task.failed` kèm retry count và last error. **Không** `task.failed` ngay lần đầu cho transient errors | Guardrail 1,2; retry budget §3 |
| O2 | Reviewer transient errors có auto-retry (Gate ON) | `review.prepare_failed`/`review.failed`/`review.unavailable` → auto-retry trước khi park `needs_human_review`. Budget exhausted → park kèm retry count và context. Gate OFF giữ nguyên behavior (async, không block) | Guardrail 5; kế thừa `plan-reviewer-coder-collaboration.md` O3/O4 |
| O3 | Retry budget và backoff strategy rõ ràng | Mỗi error type có config: max_attempts, backoff_intervals, total_timeout. Config persist ở ticket execution_policy hoặc system config. Budget exhausted emit `recovery.exhausted` event | Guardrail 1; idempotent (Guardrail 4) |
| O4 | Agent crash mid-execution resume từ checkpoint | Coder crash → detect qua `AGENT_PROCESS_EXITED` → load last checkpoint → resume execution (không restart). Resume attempt có `attempt_id` mới, link tới previous attempt. Nếu không có checkpoint → `task.failed` ngay | Guardrail 3; `ticket-resume.js`, `coder-evidence-resume.js` |
| O5 | Graceful degradation khi budget exhausted | Gate OFF: continue + label (`review_failed`, `coder_retry_exhausted`) + follow-up backlog ticket. Gate ON: park `needs_human_review` kèm full context (retry attempts, last error, partial results nếu có). **Không** silent failure | Guardrail 5; state matrix `plan-reviewer-coder-collaboration.md` |
| O6 | Observability cho recovery attempts | Mỗi recovery attempt emit event: `recovery.attempted` (error type, attempt_id, strategy), `recovery.succeeded` (attempt_id, duration), `recovery.exhausted` (error type, total attempts, last error). Events persist cho audit/UI | Guardrail bắt buộc |

**Gợi ý delivery (không bắt buộc):** Tách thành 3 nhóm: (1) Coder retry layer (O1, O3, O4) — impact lớn nhất vì `agent.response.failed` là lỗi phổ biến; (2) Reviewer retry layer (O2) — kế thừa từ `plan-reviewer-coder-collaboration.md`; (3) Observability (O6) — cross-cutting. O5 (graceful degradation) là acceptance criteria cho cả 3 nhóm.

SL tạo ticket contracts và map mỗi outcome/tiêu chí tới ≥1 ticket; không được bỏ/giảm tiêu chí hay mở rộng scope.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Retry vô hạn gây resource exhaustion | Major | Guardrail 1 | Budget hữu hạn, config được; exhausted → escalate |
| **Auto-retry re-send nguyên xi → agent code lại cùng approach → loop vô tận (câu hỏi của owner)** | Major | Phân tích code: retry **chỉ** áp dụng cho transient infra errors (provider chưa trả response — agent chưa code). Logic errors (code sai/test fail) **không auto-retry** mà đi repair loop (`startRepairRound` L129-141: attempt N+1 kèm `reason` + `findings` từ review hoặc `failed_paths` từ verification → agent sửa khác đi, có evidence từ payload text hiện tại `"Revise... Reason: {reason}. Findings: {...}"`). Riêng `verification.failed`: `review_findings` rỗng, coder chỉ nhận path-level hint → loop risk trung bình. Guardrail 2b: cùng error code lặp ≥2 lần → persistent → escalate |
| Retry che giấu persistent error | Major | Guardrail 2 | Phân loại transient/persistent rõ; persistent không retry |
| Resume từ checkpoint corrupt/stale | Major | Guardrail 3 | Validate checkpoint trước resume; corrupt → fail fast |
| Duplicate events/tickets khi retry | Major | Guardrail 4 | Idempotent retry theo `request_id + attempt_id`; dedupe |
| Recovery layer phức tạp hóa debugging | Minor | Design trade-off | Observability (O6) bù lại; log mỗi attempt rõ ràng |
| `agent.response.failed` không phân biệt được transient/persistent từ error message | Major | Evidence: code hiện tại catch-all | SL định nghĩa heuristic: timeout/network keywords = transient; others = persistent; hoặc dựa vào error.code nếu provider SDK cung cấp |
| Coder crash không để lại checkpoint | Major | Evidence: `ticket-execution-failure.js` L38 | Không có checkpoint → `task.failed` ngay (persistent); khuyến khích checkpoint frequent hơn (out of scope plan này) |
| Gate ON recovery retry trong khi owner đang chờ park | Minor | UX concern | Emit `recovery.in_progress` event để UI hiển thị; owner biết pipeline đang tự recover |
| Giả định: `ticket-resume.js`, `coder-evidence-resume.js` đủ khả năng resume | Assumption | Evidence snapshot | SL re-verify trước dispatch; nếu thiếu capability → tạo ticket discovery riêng |

## 7. Acceptance criteria của plan

- [x] Mục tiêu, in/out scope và outcomes nhất quán với yêu cầu "pipeline không dừng lỗi".
- [x] Error classification table rõ ràng: transient vs persistent vs recoverable, mỗi loại có strategy riêng. **Auto-retry chỉ cho transient infra errors (agent chưa code); logic errors đi repair loop có findings/reason (agent sửa khác đi, không re-send nguyên xi); repair budget hữu hạn → không loop vô tận.**
- [x] Retry budget và backoff strategy định nghĩa cho từng error type; không retry vô hạn.
- [x] Checkpoint-based resume cho agent crash; không restart từ đầu khi có checkpoint.
- [x] Graceful degradation: Gate OFF continue + backlog; Gate ON park có context đầy đủ.
- [x] Observability: mỗi recovery attempt có event riêng cho audit/UI.
- [x] Kế thừa `plan-reviewer-coder-collaboration.md` cho review errors; không duplicate.
- [x] Guardrail tách khỏi gợi ý delivery; re-verify source là điều kiện bắt buộc.
- [ ] **Nhận xét của SE (human owner) — chủ ý để ngỏ:** SL phải chứng minh coverage + tuân thủ policy ticket hiện hành trước dispatch, và re-verify từng path/line/SHA ở §4 trước khi chốt manifest.
- [ ] **Nhận xét của SE (human owner) — chủ ý để ngỏ:** Approval đúng identity/revision/SHA-256; lập SP không tự RUN/dispatch.

## 8. So sánh với các plan liên quan

| Plan | Scope | Plan này bổ sung gì |
| --- | --- | --- |
| `plan-reviewer-coder-collaboration.md` | Reviewer dispatch + state matrix (Gate ON/OFF) | **Coder-side recovery** (agent.response.failed, CODER_EVIDENCE_PENDING) mà plan kia chưa cover. Reviewer errors đã cover ở O3/O4 plan kia; plan này thêm retry layer chi tiết hơn |
| `plan-pause-resume-architecture.md` | Pause/resume ở cấp architecture | Plan này focus vào **automatic error recovery** ở cấp supervisor-loop, không phải manual pause/resume |
| `plan-immutable-ticket-pipeline.md` | Immutable ticket pipeline foundation | Plan này là **enhancement layer** trên nền pipeline đó |

## 9. Kết luận

Pipeline hiện tại có **14+ error paths** dẫn đến dead-end (`task.failed` hoặc `needs_human_review`) mà không có automatic recovery. Phần lớn là transient errors (provider timeout, network issue, temporary unavailability) hoàn toàn có thể tự retry. Plan này thêm **recovery middleware** vào supervisor-loop và ticket-execution-failure — thin wrapper, không thay đổi core pipeline logic, nhưng giúp pipeline "chạy trơn tru" qua phần lớn lỗi vận hành thông thường. Owner chỉ cần can thiệp cho các blocker thực sự.

**Ưu tiên implement:** (1) Coder retry layer (O1, O3, O4) — impact lớn nhất vì `agent.response.failed` là lỗi phổ biến nhất; (2) Reviewer retry layer (O2) — kế thừa từ `plan-reviewer-coder-collaboration.md`; (3) Observability (O6) — cross-cutting.

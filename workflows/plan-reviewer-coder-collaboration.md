<!-- Architecture Manager plan; không tuyên bố runtime đã thay đổi. Chủ đề: Reviewer tự động theo revision, state matrix nhất quán (soft=async hậu-integrate), identity rộng, durable contract review_*. -->
# Plan: Reviewer–Coder kết hợp nuột trên mỗi ticket, không kẹt lỗi

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Subsystem Reviewer (worker, handler, routing, verdict, findings, resume, occupancy) đã code hoàn chỉnh và có test, nhưng **đường ticket mặc định không dispatch Reviewer nội tuyến**. Bằng chứng: `ticket-coder-completion.js` mở đầu bằng comment verbatim "Completes a ticket from verified Coder evidence without dispatching an inline Reviewer"; `supervisor-loop.js` (nhánh `verification.passed`, L69-75) integrate + publish `task.completed` thẳng. Reviewer chỉ chạy khi gọi tường minh `reviewOnly` (HTTP, `start-control-api.mjs:138`) hoặc job review legacy đã migrate (`production-runtime.js:194`). Hệ quả thứ hai: khi review lỗi hạ tầng / vượt trần, ticket rơi vào `escalate`/`task.failed` thay vì tiếp tục vòng phản biện — chính là cảm giác "kẹt ở lỗi".
- **Kết quả:** Mỗi cặp (ticket, `source_revision`) mà Coder báo xong (`report_done` + bằng chứng đạt) đều được Reviewer **độc lập** xem xét theo gate; kết cục review rơi vào **một trong các trạng thái quan sát được, có bền hoá + có event** của state matrix (§3), **không mất công, không approve suông, không `task.failed` cứng**: hoặc integrate/complete, hoặc mở repair round trong giới hạn (chỉ Gate ON), hoặc dán nhãn `review_*`, hoặc dừng ở `needs_human_review` (operational) kèm dấu vết audit.
- **Giá trị:** Coder và Reviewer thật sự cộng tác theo từng revision (không còn là bước thủ công rời rạc), pipeline degrade **có dự đoán được** khi Reviewer lỗi, và **không có ticket nào bị mở lại hay bị Coder sửa sau khi đã `task.completed`** — hậu kiểm soft-gate chỉ sinh follow-up backlog.

## 2. Phạm vi

### In scope

- Nối dispatch Reviewer tự động sau khi Coder hoàn tất trong đường ticket mặc định (`submitTicket`/`completeCoderTicket`/`verification.passed`). **Cả hai gate đều dispatch**, khác nhau ở **vị trí lifecycle**: Gate ON = **blocking nội tuyến trước integrate**; Gate OFF = **non-blocking async sau `task.completed`** (xem §3).
- **State matrix** khóa hành vi theo `gate off/on` × {`approved`, `request_changes` còn/exhausted budget, Reviewer unavailable, provider failure, invalid verdict, ping-pong} (§3) — nguồn chân lý duy nhất cho O3, thay mô tả rời rạc.
- **Decision identity / idempotency** của review job, **mở rộng** theo rulebook (`base_sha`/`manifest_sha`/`review_policy_sha` + checksum file) (§3, O1) — bảo đảm "review đúng một lần cho mỗi revision, reuse chỉ khi toàn bộ key trùng".
- **Hợp đồng bền (`durable contract`) cho nhãn `review_skipped`/`review_unavailable`/`review_failed`**: nơi persist, event phát, resume semantics, quy tắc chống ghi đè (§3) — để O3 kiểm chứng được và UI/audit có nguồn tin cậy.
- **Lifecycle hậu-integrate của Gate OFF**: finding phát hiện sau `task.completed` → **follow-up backlog ticket mới**, không reopen/repair ticket đã khóa (§3).
- Bảo đảm vòng phản hồi Coder↔Reviewer "nuột": findings chuyển cho Coder qua repair round (`supervisor-loop.js:101 startRepairRound` đã gắn `review_findings`); Coder đáp trả/phản biện theo `plan-coder-explanation-review-dispute.md`.
- Định nghĩa **bậc thang phân xử tranh chấp** (§3, O5), **phân loại `needs_human_review` (operational) vs owner-decision (blocker)**, và **đường đóng finding `retain` vượt phạm vi** (hóa giải deadlock).
- Yêu cầu **re-verify source** (Guardrail 6) và **kiểm chứng E2E** (O6) làm điều kiện nghiệm thu bắt buộc.

### Out of scope

- Không đổi **public contract** của verdict (giá trị canonical `approved`/`request_changes`/`blocked`) và không đổi semantic phát event `review.approved`/`review.request_changes`/`review.failed` (`review-request-handler.js`).
- Không bỏ ràng buộc "Reviewer ≠ Coder của chính ticket" (`review-worker.js` chặn `reviewer.agent_id === job.agent_id`).
- Không nâng/nới trần `max_review_revisions` mặc định (vẫn `?? 2`) — đổi trần là quyết định policy riêng.
- Không chế `approved` giả khi Reviewer unavailable/failure; không biến `review_skipped`/`review_unavailable`/`review_failed` thành một verdict; **không** cho Gate OFF parking/block ticket.
- Không sửa rulebook `workflows/agents/reviewer/README.md`, `workflows/agents/architecture/README.md` trong plan này; không đụng `.forge/`.
- Không phân rã ticket/manifest file — quyền Sprint Leader trong boundary đã duyệt (§3/§6 rulebook).

## 3. Hướng tiếp cận và guardrails

- **Chuẩn hóa vocabulary:** giá trị **canonical của verdict** là `approved`. Reviewer README §Outcome hiện thực sự yêu cầu trả `approve`, không chỉ dùng như động từ; plan này chốt mapping tài liệu `approve` → `approved`, **không** mở parser nhận alias. Prompt/schema/runtime/event/store/UI dùng `approved`; SL phải kiểm chứng chỗ lệch trước dispatch. `blocked` không phải approval: nếu parser hiện hành không hỗ trợ thì đi nhánh invalid verdict, không nới public contract trong scope này.

- **Ràng buộc bắt buộc:**
  1. Verdict chỉ approve khi Reviewer đọc đúng vật chất đã material hoá (commit/SHA/revision); "never approve on a best-effort reconstruction" (reviewer README) → khi hạ tầng review lỗi, **không** auto-approve.
  2. Tích hợp/hoàn tất ticket **chỉ** sau `review.approved` khi gate **bật**; khi gate **tắt** (soft mặc định) ticket **không bao giờ block hay parking vì review** — review chỉ là hậu kiểm async (xem matrix).
  3. Bền hoá decision một lần và reuse khi retry (`review-request-handler.js`: `queueStore.save` + `assertCachedReviewResult`), keyed by **decision identity** dưới đây — một logical job mỗi identity, không phải mỗi ticket; không hứa exactly-once invocation của provider khi crash trước persist.
  4. Repair round chỉ tồn tại **trong Gate ON (pre-integrate)** và tôn trọng `max_review_revisions ?? 2` (`supervisor-loop.js:88`); vượt trần → dừng có chủ đích (`review_revision_limit`), không retry vô hạn.
  5. **Ticket đã `task.completed` là bất biến.** Không reopen, không repair, không đổi trạng thái vì kết quả review đến sau. Phát hiện sau hoàn tất chỉ sinh **follow-up backlog ticket mới** (`task_id` mới).
  6. **Re-verify bắt buộc:** mọi đường file/line/SHA ở §4 là **evidence snapshot**, không phải source sống. SL **phải** đối chiếu lại từng path/line/SHA với source hiện tại **trước khi** chốt manifest/ticket; discovery failure **không** được biến thành fact (rulebook §8.4). SE đã đọc store findings tại `backend/src/modules/supervisor/ticket-review-findings.js` ngày 2026-10-14; đường cũ thiếu `modules` không chứng minh subsystem không tồn tại.

  - **Decision identity / idempotency (chốt O1, mở rộng theo rulebook §6 "không bỏ gate source/index/file/hash"):** bộ khóa reuse verdict =
    `task_id + source_revision + review_commit_sha + artifact_id + base_sha + manifest_sha + review_policy_sha`.
    Retry khi **toàn bộ key trùng** → reuse verdict đã bền (`assertCachedReviewResult`), không gọi Reviewer lại khi verdict đã persist. **Bất kỳ thành phần nào đổi** (ticket contract, manifest, review policy, revision) → **key khác → review job mới**. Repair round tạo `source_revision`/`review_commit_sha` mới ⇒ job review mới (đúng: phải review lại bản đã sửa). Đây là cách chống "reuse sai khi contract/manifest/policy thay đổi" mà 4 trường cũ bỏ sót.
    `manifest_sha` phải ràng buộc snapshot ticket contract/acceptance và danh sách checksum file; `review_policy_sha` ràng buộc policy hiệu lực, gồm gate mode. SL phải chứng minh coverage hash này; nếu storage contract dùng hash riêng thì bổ sung vào identity, không được giả định 7 trường đã đủ. Gate mode được snapshot, không lật gate để thoát finding/trần repair.

  - **Hợp đồng bền cho nhãn `review_*`:** `review_skipped`/`review_unavailable`/`review_failed`/`review_revision_limit` **không phải verdict**. Persist append-only trong cùng store với verdict, tối thiểu `{ job_key(decision identity), attempt_id, outcome_label, reason_code, source_revision, created_at, event_id }`. `review_unavailable` = không có Reviewer/worker; `review_failed` = crash/provider/invalid; `review_skipped` chỉ khi có quyết định bỏ hậu kiểm Gate OFF được audit, không đồng nghĩa unavailable. Phát event tương ứng `review.skipped/unavailable/failed/revision_limit`, không phát `review.approved` cho nhãn phi-verdict.
    Outcome terminal **theo attempt**, không mutate/xóa lịch sử. Retry delivery cùng attempt reuse record; khôi phục vận hành khi chưa có verdict hợp lệ tạo attempt mới trong **cùng logical job/decision identity**, liên kết attempt trước, không cần bịa revision/policy mới. Verdict hợp lệ đã bền thì reuse, không gọi Reviewer lại. Retry vận hành có budget hữu hạn được SL chốt; không reset repair budget theo attempt/job/policy và không dùng retry để xét lại `request_changes` trên cùng vật chất.
    Persist outcome + event intent trước publish; replay dùng `event_id` ổn định và consumer dedupe, không hứa transport exactly-once. Với Gate OFF, intent hậu kiểm phải bền cùng completion trước release, dispatch chỉ sau `task.completed`; crash giữa completion/enqueue phải resume được. Giữ artifact đúng revision tới khi hậu kiểm terminal. Follow-up backlog dedupe theo `job_key + finding_id`; không mở nhiều ticket khi event bị replay.

- **Hướng đề xuất:** Enqueue job `operation:"review"` (queue `agent.request`, đã route qua `sender-worker.js:17`) ngay sau Coder checkpoint `completed`. Gate ON: enqueue **trước** integrate, Supervisor chờ verdict rồi mới quyết integrate. Gate OFF: integrate `coder_verified` trước, **sau đó** enqueue review async (non-blocking) — verdict chỉ ghi nhãn/follow-up. Đường resume đã có: `review-revision-resume.js` (`reviewPhaseResume`/`reviewRevisionResume`) tiếp tục pha review từ checkpoint Coder và rebuild findings — tái dùng thay vì viết mới.

- **State matrix (nguồn chân lý duy nhất cho mọi kết cục review):** Gate = **OFF (soft — async hậu-integrate, mặc định)** / **ON (hard — blocking nội tuyến trước integrate, `execution_policy` bật)**. `needs_human_review` (operational) **khác** owner-decision escalate (§O5 bậc 4).
  - **Cốt lõi đã sửa:** Gate OFF không bao giờ `needs_human_review`/parking/block — ticket đã `task.completed`, mọi kết cục chỉ là nhãn + follow-up. Cột OFF do đó luôn "integrated", không ô nào trái bất biến (a).

  | Điều kiện (input) | Gate OFF (soft — async sau `task.completed`) | Gate ON (hard — blocking trước integrate) |
  | --- | --- | --- |
  | `approved` (đúng artifact/revision) | ticket đã `task.completed`; ghi nhãn `review.approved` (hậu kiểm, thông tin) | integrate → `task.completed` (reviewed) |
  | `blocked` / evidence gap | ticket đã `task.completed`; audit + follow-up backlog, không reopen | không integrate; `needs_human_review`; Blocker an toàn/contract → owner-decision; parser không hỗ trợ `blocked` → nhánh invalid |
  | `request_changes`, còn budget | ticket đã `task.completed`; **mở follow-up backlog ticket mới**, **không** reopen/repair ticket khóa | **không** integrate; mở repair round với `review_findings` (tới khi hết budget) |
  | `request_changes`, exhausted = `review_revision_limit` | ticket đã `task.completed`; nhãn `review.request_changes` + backlog; **không** parking, **không** block | `needs_human_review` (operational) + `review_revision_limit` |
  | Reviewer **unavailable** (`REVIEWER_NOT_AVAILABLE`/`REVIEW_WORKER_UNAVAILABLE`) | ticket đã `task.completed`; nhãn `review_unavailable`, **không** block, **không** needs_human | `needs_human_review` (operational) — gate bật mà không Reviewer thì không bỏ qua review, **không** `task.failed` |
  | **Provider failure / crash** (`REVIEW_FAILED`) | ticket đã `task.completed`; nhãn `review_failed` (tín hiệu), không block | `needs_human_review` (operational); **không** auto-approve, **không** `task.failed` |
  | **Invalid verdict** (`REVIEW_VERDICT_INVALID`) | ticket đã `task.completed`; nhãn `review_failed` (invalid ≠ approve), không block | `needs_human_review` (operational) |
  | **Ping-pong** cùng finding qua `max_review_revisions` (O5 bậc 3) | ticket đã `task.completed`; nhãn + follow-up backlog; **không** parking | SL dừng vòng → `needs_human_review` (operational), không auto-approve |

  **Bất biến matrix:** (a) gate **OFF** ⇒ ticket luôn `task.completed` khi review chạy, không parking/reopen; Blocker hậu kiểm vẫn cảnh báo owner và tạo follow-up ưu tiên, không sửa trạng thái ticket gốc; (b) gate **ON** ⇒ chỉ `approved` đúng identity **và không còn finding blocking mở** được integrate; `request_changes` còn budget đi repair, các nhánh không-approve còn lại parking `needs_human_review`, không `task.failed`; (c) nhãn phi-verdict không bao giờ = `approved`. Exhausted/ping-pong chỉ áp dụng Gate ON; Gate OFF không có repair budget của ticket gốc.

- **Phân quyền trong sprint:** Architecture chỉ khóa outcomes, in/out scope, guardrails và acceptance cấp outcome. Mọi lựa chọn **delivery** (số/tên/ID ticket, phân rã, thứ tự, song song, file thực tế, tiêu chí chi tiết) là **SL quyết cuối**, không hỏi lại owner. SL chỉ escalate khi chạm guardrail **khóa** (verdict contract, Reviewer ≠ Coder, trần `max_review_revisions`, không auto-approve, bất biến ticket đã complete, không bịa `approved`) hoặc đổi scope/outcome (§6/§7 rulebook).

- **Phân loại escalate (hóa giải mâu thuẫn O5 ↔ plan dispute):**
  - **`needs_human_review` = trạng thái dừng VẬN HÀNH** (chỉ xuất hiện ở Gate ON, xem matrix: exhausted budget, unavailable/failure/invalid, ping-pong). SL **tự xử lý trong sprint** khi nguyên nhân vận hành: cung cấp thiếu artifact/SHA, re-run khi provider hồi phục — **không** cần quyết định sản phẩm.
  - **owner-decision escalate (blocker) = tập hẹp** chỉ hai loại (O5 bậc 4): (a) mâu thuẫn **quyết định sản phẩm/contract** chưa ủy quyền hoặc vỡ guardrail khóa; (b) **Blocker an toàn/mất dữ liệu** theo reviewer README — luôn kèm hồ sơ tổng hợp.
  - Quy tắc nối: ticket `needs_human_review` (operational) **chỉ** leo lên owner-decision nếu SL triage ra nguyên nhân thật là (a)/(b). Thống nhất "mọi bất đồng chưa giải trong bounded budget → human review" (plan dispute) với "chỉ 2 loại lên owner" (O5): human **review** (operational parking, Gate ON) ≠ human **decision** (blocker).

- **Bậc thang phân xử tranh chấp Reviewer↔Coder (SL quyết cuối trong sprint):** khi bất đồng về một finding (Coder `dispute`, Reviewer `retain`/`refine`):
  - **Bậc 1 — Reviewer tự phân xử (technical).** Adjudicate đúng `finding_id` theo `plan-coder-explanation-review-dispute.md`: `withdraw`/`not_applicable` (Reviewer tự nhận sai, kèm audit evidence) hoặc `fixed` (xác nhận trên revision đã verify) → finding đóng, **không** cần SL/human. Chỉ `retain`/`refine` còn lại đi bậc 2.
  - **Bậc 2 — SL trọng tài về PHẠM VI & DELIVERY (không về đúng/sai kỹ thuật).** Guardrail khóa: **SL không được lật nghiệm thu kỹ thuật** và **không được tự đóng finding `retain`**. Do đó gắn nhãn out-of-scope/backlog **không** làm finding biến mất và **không** mở đường cho Gate ON integrate (đây chính là deadlock reviewer chỉ ra). **Hai lối thoát hợp lệ duy nhất, phải chọn rõ:**
    - (2A) **Reviewer adjudicate `not_applicable`** — Reviewer xác nhận finding không áp dụng cho revision/phạm vi ticket (out-of-scope do Reviewer phán, có audit evidence) → finding đóng → Gate ON mới được integrate.
    - (2B) **Reviewer vẫn `retain` nhưng việc đòi sửa vượt in-scope ticket** → đây là **xung đột phạm vi (contract/scope)**, **vượt thẩm quyền SL** (§7 rulebook: đổi in/out scope phải về Architecture/human) → **owner-decision escalate** kèm hồ sơ; **không** tích hợp ticket khi finding `retain` còn mở.
    → SL **không** còn quyền "gắn backlog rồi cho integrate" nửa vời: hoặc Reviewer đóng bằng `not_applicable` (2A), hoặc lên owner (2B).
  - **Bậc 3 — SL dừng vòng khi ping-pong/chạm trần.** Cùng finding `dispute`↔`retain` lặp qua `max_review_revisions`, hoặc Reviewer lặp string-finding không có criterion/evidence/`minimum_change_scope` mới → SL **ngắt vòng**, degrade về `needs_human_review` **(operational)**, không sửa vô hạn, không auto-approve. Đây là ô "exhausted/ping-pong" Gate ON của matrix, **không** phải owner-decision escalate.
  - **Bậc 4 — owner-decision escalate (chỉ 2 loại)** như trên. SL **tổng hợp sẵn hồ sơ** (finding + lịch sử dispute + bằng chứng hai phía + manifest/policy liên quan) rồi mới escalate. Quyết định human ghi tường minh, **không** giả mạo thành verdict.
  - **Bất biến:** *Coder khiếu nại → Reviewer phân xử → SL/Supervisor chỉ thi hành quyết định đã được audit; SL không tự phân xử đúng/sai kỹ thuật, không tự đóng `retain`, không reopen ticket đã complete.*

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `supervisor/ticket-coder-completion.js` | Đường hoàn tất mặc định, hiện BỎ QUA Reviewer | Header comment verbatim; sha256:22f50cb3…; chắc chắn cao |
| `supervisor/supervisor-loop.js` | Nhánh `review.approved/request_changes/failed`; `startRepairRound` gắn findings; trần revision | L69-96; sha256:b106accb…; facts |
| `supervisor/review-request-handler.js` | Bền verdict (`queueStore.save`/`assertCachedReviewResult`) + phát event review.* | sha256:a3080a3b…; facts |
| `supervisor/nodeforge-task-integration.js` | `submitTicket`/`reviewOnly`/`selectTicketCoder`; enqueue handoff | L78-190, L34-77; sha256:91c81d01…; facts |
| `supervisor/sender-worker.js` | Route `operation==="review"` → reviewHandler | L17; facts |
| `supervisor/review-revision-resume.js` | Tiếp tục pha review từ checkpoint | sha256:675dbf2e…; facts |
| `backend/src/modules/supervisor/ticket-review-findings.js` | Store report/response/review/resolution; `assertResolved` | SE đã đọc source 2026-10-14; SL vẫn re-verify SHA/contract trước manifest (Guardrail 6) |
| `production-runtime.js` | Nơi duy nhất gán `operation:"review"` (legacy migrate) | L194; facts |
| `workflows/plan-coder-explanation-review-dispute.md` | Hợp đồng phản biện/tranh luận đã soạn | sha256:be576cfb…; kế thừa |

Các khu vực là định hướng discovery, không phải allowlist file bất biến. **SL xác minh đường thực tế trước khi chốt manifest (Guardrail 6, bắt buộc).**

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Reviewer chạy tự động sau Coder **theo revision**, cả hai gate, đúng lifecycle | Mỗi decision-identity-key (tối thiểu 7 trường + coverage hash §3) Coder-completed tạo đúng **một logical** job `operation:"review"`: Gate ON trước integrate, Gate OFF dispatch sau `task.completed`. Toàn-key trùng → reuse verdict đã persist; vận hành recovery theo attempt. Identity đổi → logical job mới, không reset repair budget | Guardrail 3 + decision identity §3; resume `review-revision-resume.js` |
| O2 | Vòng phản hồi nuột (chỉ Gate ON): request_changes → Coder sửa | `review.request_changes` (Gate ON) mở repair round ≤ `max_review_revisions`; payload Coder chứa `review_findings` (`supervisor-loop.js:101`); Coder đáp trả (`respond_to_review`, plan dispute). Gate OFF **không** repair ticket đã complete | Guardrail 4,5; store findings (xác minh lại đường) |
| O3 | Không kẹt lỗi — **đúng state matrix**, mỗi ô kiểm chứng được | Từng ô reproduce với bản ghi + event đúng loại: Gate OFF luôn giữ `task.completed`; Gate ON `request_changes` còn budget đi repair, nhánh không-approve còn lại parking; không `task.failed` vì review, không auto-approve. Record theo attempt append-only, retry hữu hạn, không reset repair budget | State matrix §3; durable contract; Guardrail 1,2,4 |
| O4 | Không phá default khi gate tắt + **lifecycle hậu-integrate rõ** | `task.completed`/`completion:"coder_verified"` giữ nguyên; review async chỉ ghi nhãn hoặc mở **follow-up backlog ticket mới** (task_id mới); **không** reopen ticket đã khóa; **không** cần Reviewer tồn tại để hoàn tất | Matrix cột Gate OFF; Guardrail 2,5 |
| O5 | Tranh chấp phân xử theo bậc thang; SL quyết cuối; **không deadlock** | Bậc 1 `withdraw/not_applicable/fixed` (kèm audit) đóng finding. Bậc 2: SL **không** tự đóng `retain`; chỉ (2A) Reviewer `not_applicable` **hoặc** (2B) scope conflict → owner escalate. Bậc 3 ping-pong → `needs_human_review` operational. Bậc 4 chỉ contract/sản phẩm hoặc Blocker an toàn → owner-decision kèm hồ sơ. Operational parking ≠ owner escalate | Guardrail khóa; bất biến dispute; phân loại escalate §3 |
| O6 | Kiểm chứng E2E của luồng | Test tự động: (happy) Coder report → dispatch review → `request_changes` → repair revision (source_revision mới → job mới) → `approved` → integrate/`task.completed`; (lỗi) provider failure / invalid verdict / exhausted **không** integrate khi gate ON, **không** auto-approve ở mọi gate; (soft) Gate OFF → ticket đã complete, finding đến sau tạo **follow-up backlog ticket mới**, ticket gốc không đổi trạng thái | O1–O4; integration test (nền `immutable-ticket-pipeline`) |

O6 còn phải cover unavailable/blocked/ping-pong; stale identity/checksum và finding blocking mở không integrate; duplicate completion/event chỉ một logical job/follow-up; restart sau persist trước publish và completion trước enqueue không mất hậu kiểm; unavailable → attempt recovery trên cùng identity không reset budget. Đây là acceptance cho implementation, **chưa phải test đã chạy/pass**.

**Gợi ý delivery (không bắt buộc):** tách nhánh review-dispatch + lifecycle (O1), review-repair-loop Gate ON (O2), review-failure-handling + matrix + durable label contract (O3/O4), dispute-ladder + deadlock fix (O5), E2E (O6). Bắt đầu bằng O3/O4 (an toàn lỗi + soft-gate async) để "không kẹt" có hiệu lực sớm, rồi mới O1 gate ON. SL tự quyết trình tự/phân rã, không chờ owner duyệt lại.

SL tạo ticket contracts và map mỗi outcome/tiêu chí tới ≥1 ticket; không được bỏ/giảm tiêu chí hay mở rộng scope.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Gate OFF không nhất quán: matrix để `request_changes`/ping-pong → `needs_human_review` trái bất biến "OFF không tắc" | Major (đã sửa) | reviewer round-2 flag | Gate OFF = **async hậu-integrate**, ticket luôn `task.completed`; mọi kết cục OFF chỉ nhãn + follow-up backlog, **không** parking/block |
| Chưa định nghĩa Gate OFF khi nào dispatch review | Major (đã sửa) | reviewer flag | Chốt: Gate ON blocking trước integrate; Gate OFF async sau `task.completed` (§3 Hướng đề xuất, O1) |
| Repair cho ticket đã integrate (Gate OFF) | Major (đã sửa) | reviewer flag | Cấm reopen; finding sau hoàn tất → **follow-up backlog ticket mới**, ticket gốc bất biến (Guardrail 5, O4) |
| Decision identity 4 trường reuse sai khi contract/manifest/policy đổi | Major (đã sửa) | reviewer flag, rulebook §6 | Mở rộng 7 trường (`+base_sha+manifest_sha+review_policy_sha`); reuse chỉ khi toàn-key trùng (Guardrail 3, O1) |
| Bậc 2 deadlock: SL gắn backlog nhưng không đóng `retain`, Gate ON không integrate được | Major (đã sửa) | reviewer flag | SL **không** tự đóng `retain`; chỉ (2A) Reviewer `not_applicable` kèm audit **hoặc** (2B) scope conflict → owner escalate (O5 bậc 2) |
| `review_*` là "nhãn" nhưng thiếu durable contract → O3 khó verify, UI/audit không có nguồn | Major (đã sửa) | reviewer flag | **Hợp đồng bền**: append-only theo attempt; verdict reuse theo job_key; event intent + dedupe (§3) |
| `approve` (rulebook) vs `approved` (plan) lệch vocabulary | Minor (policy đã chốt) | Reviewer README §Outcome yêu cầu `approve` | Mapping tài liệu → `approved`, không mở parser alias; SL verify prompt/runtime trước dispatch (§3) |
| Thiếu Reviewer khả dụng làm chậm/tắc ticket | Major → đã hóa giải | `REVIEWER_NOT_AVAILABLE`/`REVIEW_WORKER_UNAVAILABLE`; matrix Gate OFF | Soft ⇒ `review_unavailable` + ticket vẫn completed; hard ⇒ parking; recovery theo attempt, không đổi identity giả |
| O5 "chỉ 2 loại lên human" vs plan dispute "mọi bất đồng bounded-budget → human review" | Major (đã sửa) | reviewer round-1 flag | Tách **`needs_human_review` (operational, Gate ON)** khỏi **owner-decision (blocker)**; SL triage trước khi escalate |
| "Một ticket một job" sai khi có repair revision | Major (đã sửa) | reviewer round-1 flag | Decision identity theo revision; repair revision mới → job review mới (O1) |
| "Gate tắt ghi verdict như tín hiệu" bất khả thi khi Reviewer không tồn tại | Major (đã sửa) | reviewer round-1 flag | Tách `review_skipped/unavailable/failed` (nhãn bền) khỏi verdict (matrix + durable contract) |
| Ping-pong chạm trần 2 → escalate thường xuyên | Major → giảm nhờ O5 | `max_review_revisions ?? 2`; plan dispute §5 | O5 bậc 1 đóng, bậc 2 phân loại (không deadlock), bậc 3 parking operational; chỉ bậc 4 lên owner |
| Verdict JSON nghiêm ngặt: provider trả văn xuôi → `REVIEW_VERDICT_INVALID` | Minor | `review-worker.js` strict `parseVerdict` | Giữ nguyên; matrix route Gate ON → needs_human, Gate OFF → `review_failed` + ticket complete; không nới parser |
| Evidence snapshot có path/line/SHA cũ | Gate bắt buộc trước manifest | Store thật ở `backend/src/modules/supervisor/ticket-review-findings.js` | SE đã xác minh path; SL vẫn re-verify toàn §4, discovery failure ≠ fact |
| Assumption: không còn đường enqueue review ẩn nào khác; Gate OFF async không tranh chấp occupancy | Assumption | Search `operation:"review"` chỉ thấy legacy migrate + tests | SL re-verify `submitTicket`/`startTask` và enqueue ordering khi lập SP |

## 7. Acceptance criteria của plan

- [x] Mục tiêu, in/out scope và outcomes nhất quán với yêu cầu "kết hợp nuột + không kẹt lỗi".
- [x] **State matrix** là nguồn chân lý duy nhất; Gate OFF = async hậu-integrate nên **không** ô nào trái bất biến "OFF không tắc/không parking".
- [x] **Lifecycle Gate OFF** định nghĩa rõ (dispatch async sau `task.completed`; finding sau hoàn tất → follow-up backlog ticket mới; cấm reopen ticket đã khóa).
- [x] **Decision identity** tối thiểu 7 trường, ràng buộc contract/checksum/gate snapshot; reuse chỉ khi toàn-key trùng, bổ sung hash riêng nếu contract hiện hành cần.
- [x] **Deadlock Bậc 2 đã gỡ**: SL không tự đóng `retain`; out-of-scope = Reviewer `not_applicable` (2A) **hoặc** owner escalate vì scope conflict (2B).
- [x] **Durable contract**: append-only theo attempt, verdict reuse theo job_key, retry hữu hạn không reset repair budget; event/completion intent recoverable và dedupe follow-up.
- [x] **Vocabulary canonical** `approved` chốt một chiều, không hai hằng số.
- [x] **Phân loại escalate**: `needs_human_review` (operational, Gate ON) tách khỏi owner-decision (blocker).
- [x] Guardrail tách khỏi gợi ý delivery; **re-verify source là điều kiện bắt buộc** (Guardrail 6).
- [x] E2E cụ thể cho happy + Gate ON lỗi + Gate OFF follow-up backlog (O6).
- [ ] **Nhận xét của SE (human owner) — chủ ý để ngỏ, không phải thiếu sót:** SL phải chứng minh coverage + tuân thủ policy ticket hiện hành **trước dispatch**, và **re-verify từng path/line/SHA ở §4 (Guardrail 6)** trước khi chốt manifest. Đây là hành động **hạ lưu** thuộc quyền/trách nhiệm SL khi lập SP, ngoài phạm vi tick của plan kiến trúc (rulebook §3/§4).
- [ ] **Nhận xét của SE (human owner) — chủ ý để ngỏ, không phải thiếu sót:** Approval đúng identity/revision/SHA-256; lập SP **không** tự RUN/dispatch. Thuộc **contract lưu trữ/phê duyệt của human owner (SE)** theo rulebook §4/§6; Architecture không tự approve.

> **Chú thích §7:** Hai mục cuối là **SE-owned / downstream**, được giữ unchecked một cách **chủ ý** — chúng là điều kiện SE nhận xét và phê duyệt sau khi plan được chấp thuận, không phải hạng mục Architecture tự tick. Plan vẫn là **tài liệu thảo — chưa phải plan đã duyệt, chưa cấp RUN/dispatch**.

**Kết luận SE — 2026-10-14:** Chốt nội dung kiến trúc với các làm rõ tại §3/O6; đủ nền cho SL phân rã sau approval hợp lệ. Không coi nhận xét này là receipt approval theo storage contract, không tự tick hai gate hạ lưu, không cấp RUN/dispatch và không tuyên bố runtime đã triển khai. SE chỉ sửa plan, không sửa rulebook/schema/source runtime trong lượt review này.

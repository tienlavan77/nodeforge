<!-- Architecture Manager workspace for project workflow definitions. -->
<!-- Phan loai error type theo doi tuon xu ly: Forge / subagent / reviewer / owner (thao luan 2026-10-15). -->
# Workflows

Architecture Manager may read, create, update, and delete workflow files here through Forge File Service tools.

# Phân loại error type theo đối tượng xử lý

Tóm tắt thảo luận 2026-10-15 (tiếng Việt). Phân loại các error type trong pipeline theo ai xử lý được: Forge tự phục hồi, subagent tự sửa, reviewer hướng dẫn sửa, hay owner quyết định.

**Quyết định owner 2026-10-15:**

1. Nhóm 1 (Forge auto-retry): retry theo chu kỳ **30 giây/lần** (interval 30s), vẫn trong budget retry hiện có.
2. Nhóm 2 (subagent tự sửa): giữ nguyên như hiện tại — OK.
3. Nhóm 3 (reviewer + findings): reviewer phải **hướng dẫn chi tiết** cho subagent (mỗi finding có mô tả cụ thể, vị trí, cách sửa, không chỉ tiêu đề).
4. Nhóm 4 (owner quyết định): owner chỉ can thiệp khi lỗi **thực sự yêu cầu thay đổi cấu trúc dự án**; các trường hợp còn lại **Technical Lead (SL) chốt luôn**, không cần chờ owner từng case.

## 1. Forge xử lý tự động (subagent không cần làm gì — pipeline recovery)

| Error | Cơ chế |
|---|---|
| `agent.response.failed` (transient infra) | Emit `task.failed`; theo resilience plan → auto-retry backoff |
| `AGENT_PROCESS_EXITED` / `SERVICE_UNAVAILABLE` | `ticket-execution-failure.js` xếp recoverable → resume/checkpoint |
| `review.failed` / `review.unavailable` (`REVIEW_WORKER_UNAVAILABLE`, `REVIEWER_NOT_AVAILABLE`, `REVIEWER_PROVIDER_UNAVAILABLE`) | Park `needs_human_review`; retry qua `automaticReview.retry()` (budget `max_operational_attempts`) |
| `REVIEW_PROVIDER_OUTCOME_UNKNOWN` | Invocation bị ngắt → chỉ audited operational retry |
| `REVIEW_RETRY_LIMIT` / `review_revision_limit` | Budget cạn → park có chủ đích, không retry tiếp |
| `TICKET_INTEGRATION_FAILED` | Catch trong supervisor-loop → parkReview |

## 2. Subagent (Coder) tự xử lý được — nhận hướng dẫn cụ thể

| Error | Hướng dẫn subagent nhận |
|---|---|
| `VERIFY_FAILED` / `VERIFY_RETRY_UNCHANGED` | Repair round với `failed_paths` trong prompt. `VERIFY_RETRY_UNCHANGED`: cùng commit fail ≥N lần → phải sửa cause, cấm retry nguyên xi |
| `changeset.collected` empty | Repair reason `empty_changeset` — phải tạo thay đổi thật |
| `CODER_EVIDENCE_PENDING` | "Run the missing checks and retry report_done with verified acceptance coverage"; resume path có prompt "EVIDENCE RECOVERY" |
| `AGENT_REPORT_MISSING` | Phải theo completion sequence: commit_changes → report_done |
| `REVIEW_REPAIR_REVISION_REQUIRED` | Repair phải submit revision mới, không re-submit nguyên xi |

## 3. Cần Reviewer + findings → hướng dẫn sửa cho subagent

| Error | Luồng |
|---|---|
| `review.request_changes` | `startRepairRound("review_request_changes")` — findings truyền qua cả `text` lẫn `review_findings` → subagent nhận hướng dẫn từng finding |
| `REVIEW_FINDINGS_UNRESOLVED` | Finding open chặn approve → resolve từng finding (fix hoặc respond + reviewer adjudicate) |
| `REVIEW_VERDICT_INVALID` | Lỗi của **Reviewer agent** → re-dispatch reviewer, không phải lỗi Coder |
| `FINDING_RESOLUTION_EVIDENCE` | Finding "fixed" nhưng path không đổi → Coder phải thật sự sửa path đó |

## 4. Cần owner / "agent master" quyết định — subagent không được tự xử lý

| Error | Lý do |
|---|---|
| `CODER_BLOCKED` | Prompt quy định: không được tự sáng quyền → stop, chờ owner |
| `COMMIT_APPROVAL_REJECTED` | Owner đã reject — human decision |
| `REVIEW_POLICY_CONFLICT` / `REVIEW_POLICY_INVALID` / `REVIEW_SOFT_PARK_FORBIDDEN` / `REVIEW_SKIP_FORBIDDEN` | Lỗi policy/config → người cấu hình chốt |
| `REVIEW_EVIDENCE_MISMATCH` / `REVIEW_COMMIT_STALE` / `REVIEW_EVIDENCE_STALE` / `REVIEW_SOURCE_MISMATCH` | Evidence identity lệch → reconcile vận hành, không phải sửa code |
| `HUMAN_REVIEW_*` (`REGISTRY_REQUIRED`, `STALE`, `ACTIVE`, `STATUS_INVALID`) | Owner approval flow, human-only |
| `REVIEW_STATUS_INVALID` / `REVIEW_JOB_MISSING` / `REVIEW_ATTEMPT_ACTIVE` | Trạng thái vận hành — supervisor/owner reconcile |

## Rule of thumb

- Lỗi logic của Coder → subagent tự sửa có guidance (findings / failed_paths).
- Lỗi evidence-identity / policy / authority → owner.
- Lỗi verdict/công cụ của Reviewer → re-dispatch Reviewer.
- Transient infra → Forge retry trong budget.

## Sơ đồ pipeline xử lý lỗi (2026-10-15)

```
                         ┌──────────────────────────────┐
                         │   LỖI XẢY RA TRONG PIPELINE  │
                         └──────────────┬───────────────┘
                                        │
                          Lỗi gì? (classify theo ticket-execution-failure.js)
                                        │
        ┌───────────────┬───────────────┼─────────────────┬────────────────┐
        ▼               ▼               ▼                 ▼                ▼
   TRANSIENT infra   CODER logic    REVIEWER lỗi     REVIEW verdict   POLICY / authority
  (infra/worker down) (code sai)   (verdict invalid)  (request_changes) (block/policy/human)
        │               │               │                 │                │
        ▼               ▼               ▼                 ▼                ▼
┌──────────────┐ ┌─────────────┐ ┌─────────────────┐ ┌──────────────┐ ┌──────────────────┐
│ NHÓM 1       │ │ NHÓM 2      │ │ NHÓM 3          │ │ (cũng NHÓM 3) │ │ NHÓM 4           │
│ FORGE RETRY  │ │ SUBAGENT    │ │ RE-DISPATCH     │ │ REPAIR ROUND  │ │ QUYẾT ĐỊNH       │
│              │ │ TỰ SỬA      │ │ REVIEWER        │ │               │ │                  │
│ Retry 30s/   │ │             │ │ (verdict lỗi là │ │ findings      │ │ Đụng cấu trúc    │
│ lần trong    │ │ Repair có   │ │  lỗi Reviewer,  │ │ chi tiết →    │ │ dự án?           │
│ budget       │ │ hướng dẫn   │ │  không phải     │ │ subagent sửa  │ │   ├── CÓ → OWNER │
│ (max_operational_attempts) │ cụ thể  │  lỗi Coder)  │  │ từng finding  │ │   └── KHÔNG → SL │
└──────┬───────┘ └──────┬──────┘ └─────────────────┘ └──────┬───────┘ └───────┬──────────┘
       │                │                                        │                 │
       ▼                ▼                                        ▼                 ▼
   budget cạn →     commit → VERIFY                         findings resolve   resolve rồi
   park có chủ đích (kiểm chứng)                            → approve          resume ticket
```

Luồng chính sau khi subagent sửa (nhóm 2 & 3):

```
 Coder sửa ──► commit ──► VERIFY
                            │
            VERIFY_FAILED ──┤ (cùng commit fail ≥N lần → cấm retry nguyên xi, sửa cause)
                            ▼
                       REVIEW
                            │
        request_changes ────┼──── findings + hướng dẫn chi tiết ──► repair round
        findings unresolved ─┤    (fix path thật, hoặc respond → reviewer adjudicate)
        approve ────────────┴──► TICKET_INTEGRATION ──► done
                                  │
                                  └ TICKET_INTEGRATION_FAILED → parkReview (Forge catch)
```

## Nguồn (repository facts)

- `backend/src/modules/supervisor/supervisor-loop.js` — event routing, review budget, integration failure catch.
- `backend/src/modules/supervisor/ticket-execution-failure.js` — phân loại recoverable vs terminal.
- `backend/src/modules/supervisor/ticket-verification-service.js` — `VERIFY_FAILED`, `VERIFY_RETRY_UNCHANGED`.
- `backend/src/modules/supervisor/automatic-ticket-review.js` — retry budget, `consumeRepair()`, `max_operational_attempts`.
- `backend/src/modules/supervisor/completion-report-service.js` — `assertCoderCoverage`, `CODER_EVIDENCE_PENDING`.
- `backend/src/modules/supervisor/review-worker.js`, `ticket-review-findings.js`, `nodeforge-task-prompts.js`, `ticket-resume.js`.

## Rủi ro và câu hỏi mở

- `agent.response.failed` hiện chưa có retry — xem `workflows/plan-pipeline-resilience-never-stuck.md`.
- `verification.failed` repair chỉ gửi `failed_paths` với `review_findings` rỗng — tín hiệu yếu, rủi ro loop trung bình.
- Repair loop chỉ giới hạn bởi budget; chưa có same-failure-pattern guardrail để escalate sớm.
- Chưa phân biệt transient vs persistent — cần để quyết định retry hay escalate.

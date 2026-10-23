Tổng hợp các error type theo **ai xử lý được** (nguồn: 
supervisor-loop.js
Copy
, 
ticket-execution-failure.js
Copy
, 
ticket-verification-service.js
Copy
, 
automatic-ticket-review.js
Copy
, 
completion-report-service.js
Copy
, 
review-worker.js
Copy
, 
ticket-review-findings.js
Copy
):

## 1. Forge xử lý tự động (subagent không cần làm gì — pipeline recovery)

| Error | Cơ chế | |---|---| | 
agent.response.failed
Copy
 (transient infra) | Emit 
task.failed
Copy
 hiện tại; theo plan resilience → auto-retry backoff | | 
AGENT_PROCESS_EXITED
Copy
 / 
SERVICE_UNAVAILABLE
Copy
 | 
ticket-execution-failure.js
Copy
 L47: recoverable, resume/checkpoint path | | 
review.failed
Copy
 / 
review.unavailable
Copy
 (
REVIEW_WORKER_UNAVAILABLE
Copy
, 
REVIEWER_NOT_AVAILABLE
Copy
, 
REVIEWER_PROVIDER_UNAVAILABLE
Copy
) | Park 
needs_human_review
Copy
; retry qua 
automaticReview.retry()
Copy
 (budget 
max_operational_attempts
Copy
) | | 
REVIEW_PROVIDER_OUTCOME_UNKNOWN
Copy
 | Invocation bị ngắt → chỉ cho phép audited operational retry | | 
REVIEW_RETRY_LIMIT
Copy
 / 
review_revision_limit
Copy
 | Budget exhausted → park có chủ đích, không retry nữa | | 
TICKET_INTEGRATION_FAILED
Copy
 | Catch trong supervisor-loop L108 → parkReview |

## 2. Subagent (Coder) tự xử lý được — có hướng dẫn cụ thể

| Error | Hướng dẫn subagent nhận được | |---|---| | 
VERIFY_FAILED
Copy
 / 
VERIFY_RETRY_UNCHANGED
Copy
 (verification.failed) | Repair round: 
failed_paths
Copy
 trong prompt text; subagent sửa code rồi verify lại. Riêng 
VERIFY_RETRY_UNCHANGED
Copy
: cùng commit fail ≥N lần → **bắt buộc sửa cause**, không được retry nguyên xi | | 
changeset.collected
Copy
 empty | Repair round reason 
empty_changeset
Copy
 — subagent phải thực hiện thay đổi thật | | 
CODER_EVIDENCE_PENDING
Copy
 | Prompt ghi rõ: "run the missing checks and retry report_done with verified acceptance coverage" (nodeforge-task-prompts.js L137); resume path 
ticket-resume.js
Copy
 L165 có "EVIDENCE RECOVERY" prompt | | 
AGENT_REPORT_MISSING
Copy
 | Subagent kết thúc mà không 
report_done
Copy
 → phải gọi đúng completion sequence (commit_changes → report_done) | | 
REVIEW_REPAIR_REVISION_REQUIRED
Copy
 | Repair phải submit revision mới, không re-submit nguyên xi |

## 3. Cần Reviewer + findings → hướng dẫn sửa cho subagent

| Error | Luồng | |---|---| | 
review.request_changes
Copy
 (findings đầy đủ) | 
startRepairRound(reason="review_request_changes")
Copy
 — findings truyền vào cả 
text
Copy
 lẫn 
review_findings
Copy
 → subagent nhận hướng dẫn từng finding | | 
REVIEW_FINDINGS_UNRESOLVED
Copy
 | Finding còn open → approve bị chặn → phải resolve từng finding (fix hoặc respond + reviewer adjudicate) | | 
REVIEW_VERDICT_INVALID
Copy
 | Reviewer trả JSON/contract sai — lỗi của **Reviewer agent**, không phải Coder → re-dispatch reviewer, không phải subagent sửa | | 
FINDING_RESOLUTION_EVIDENCE
Copy
 | Finding "fixed" nhưng path không đổi → Coder phải thật sự sửa path tương ứng |

## 4. Cần owner / "agent master" quyết định — subagent không được tự xử lý

| Error | Lý do | |---|---| | 
CODER_BLOCKED
Copy
 | Prompt quy định rõ: "Do not invent authority... stop and await an owner decision" — scope/access/security/ambiguity blocker | | 
COMMIT_APPROVAL_REJECTED
Copy
 | Owner rejected commit → decision của human | | 
REVIEW_*
Copy
 policy errors (
REVIEW_POLICY_CONFLICT
Copy
, 
REVIEW_POLICY_INVALID
Copy
, 
REVIEW_SOFT_PARK_FORBIDDEN
Copy
, 
REVIEW_SKIP_FORBIDDEN
Copy
) | Sai policy/config → người cấu hình chốt | | 
REVIEW_EVIDENCE_MISMATCH
Copy
 / 
REVIEW_COMMIT_STALE
Copy
 / 
REVIEW_EVIDENCE_STALE
Copy
 / 
REVIEW_SOURCE_MISMATCH
Copy
 | Evidence identity lệch (commit/artifact/source revision) — đòi reconcile vận hành, không phải sửa code | | 
HUMAN_REVIEW_*
Copy
 (
REGISTRY_REQUIRED
Copy
, 
STALE
Copy
, 
ACTIVE
Copy
, 
STATUS_INVALID
Copy
) | Owner approval flow, human-only | | 
REVIEW_STATUS_INVALID
Copy
, 
REVIEW_JOB_MISSING
Copy
, 
REVIEW_ATTEMPT_ACTIVE
Copy
 | Trạng thái vận hành — reconcile bởi supervisor/owner |

**Tóm tắt quy tắc:** logic error của Coder → subagent tự sửa có hướng dẫn (findings/failed_paths); lỗi evidence-identity/policy/authority → owner; lỗi verdict/tools của Reviewer → re-dispatch Reviewer; transient infra → Forge retry có budget.
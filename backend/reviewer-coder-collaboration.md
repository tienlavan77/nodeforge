<!-- Records automatic Reviewer implementation, bounded recovery, and verification limits without granting ticket RUN authority. -->
# Reviewer–Coder collaboration: triển khai và vận hành

## Phạm vi

Triển khai theo `workflows/plan-reviewer-coder-collaboration.md` trong đường ticket
production (`submitTicket`/`completeCoderTicket` và Supervisor `verification.passed`).
Không thay đổi đường direct-code, parser verdict độc lập hay quyền approval/RUN của owner.
Tài liệu này không thay thế manifest, approval theo SHA hoặc gate dispatch của Sprint Leader.

## Cấu hình

Trong ticket contract đã phê duyệt:

```json
{
  "execution_policy": {
    "review_gate": "on",
    "max_review_revisions": 2
  }
}
```

- `review_gate`: `off` mặc định; `on` yêu cầu review trước integrate.
- `max_review_revisions`: số nguyên không âm, mặc định 2; 0 không cho repair.
- Snapshot gate/budget không được đổi giữa các review của cùng ticket.
- Thay đổi ticket contract phải theo quy trình approval hiện hành, không sửa policy
  để né finding hoặc tăng budget sau khi thực thi.
- Reviewer phải độc lập với Coder, khả dụng theo routing/occupancy hiện hành.

## Lifecycle và dữ liệu bền

**Gate ON:** Coder report + passed artifact → review → `request_changes` → repair
bounded → artifact/identity mới → review mới → `approved` + không còn finding mở
→ integrate → `task.completed`. Lỗi hạ tầng, verdict invalid, hết budget hoặc repair
không có revision/response mới → `needs_human_review`, không auto-approve/integrate.
Blocker an toàn hoặc finding vượt approved scope yêu cầu owner decision, không
đẩy vào vòng repair thông thường.

**Gate OFF:** chuẩn bị snapshot → integrate + `task.completed` → enqueue review async.
Kết cục review không park/reopen/sửa ticket gốc. Finding sinh backlog độc lập.
Reviewer unavailable/failed là outcome phi-verdict; `review_skipped` chỉ được
ghi tường minh kèm lý do cho đúng completed revision.

Store production mặc định dùng `.forge/runtime`:

- `.forge/runtime/queues/agent.request.json`: job `operation: "review"`,
  `automatic_review: true`, identity, source snapshot, outcomes, event intent.
- Identity gồm 7 trường plan và các hash riêng của ticket contract, file checksums,
  Coder report/responses. Reuse chỉ khi toàn bộ identity khớp.
- `outcomes` append-only theo operational attempt; `parking_outcomes` lưu riêng
  từng attempt/reason và dedupe replay. Không coi outcome lỗi là approval.
- Retry operational tối đa 3 attempts cho một logical identity. Repair budget
  đếm từ `repair_consumed` trên toàn bộ revision của ticket, không reset khi retry.
- `running_attempt` được lưu trước provider invocation. Recovery ghi
  `REVIEW_PROVIDER_OUTCOME_UNKNOWN` nếu invocation bị ngắt; không tự gọi lại provider.
- Verdict/outcome và stable event ID lưu trước publish/ack; completion intent dùng
  event ID riêng. Recovery replay intent và dispatch soft review sau terminal context.
- Soft Reviewer đọc retained Git blobs của review commit, không đọc source live đã
  bị thay đổi sau integrate; tool đọc vẫn read-only, checksum/scope/size bounded.
- `.forge/runtime/queues/review.backlog.json`: follow-up IDs `TICKET-REVIEW-<hash>`,
  owner `sprint_leader`, trạng thái `planned`, dedupe theo job/finding.

**Backlog là đề xuất ticket**, chưa phải ticket runnable trong Sprint Registry.
SL phải phân loại, bổ sung contract, manifest và lấy approval theo quy trình bình
thường; runtime không tự cấp RUN cho follow-up. Finding `retain` không được đóng
bởi SL/Coder; chỉ Reviewer adjudication hợp lệ hoặc human disposition hiện hành.

Owner RUN để resume review giữ execution ID/basis gốc sau revalidation transactional
của status, dependencies và launch ownership; không reopen ticket `done` và không
bỏ qua provider launch chưa reconcile. Khi review queue storage hỏng ngay lúc prepare,
fallback phát audit lỗi: hard park, soft complete trước audit lỗi. Không thể hứa có
job outcome bền khi chính store không ghi được; cần phục hồi storage và đối chiếu audit.

## Mapping acceptance

| Outcome | Source chính | Kiểm chứng focused |
| --- | --- | --- |
| O1 dispatch/identity | `automatic-ticket-review.js`, `automatic-review-identity.js` | `automatic-ticket-review.test.js`, `automatic-review-loop.test.js` |
| O2 repair bounded | `ticket-coder-completion.js`, `ticket-review-repair.js` | `automatic-review-completion.test.js`, `automatic-review-loop.test.js` |
| O3 state/outcome/recovery | `automatic-review-audit.js`, `recovery-evidence.js` | `automatic-review-recovery.test.js`, `automatic-review-execution-resume.test.js` |
| O4 soft post-completion | `automatic-review-source.js`, `committed-review-window.js` | `automatic-review-source.test.js`, `automatic-ticket-review.test.js` |
| O5 finding/owner authority | `automatic-ticket-review.js`, existing finding store | `ticket-review-findings.test.js`, `automatic-review-completion.test.js` |
| O6 E2E tối thiểu | inline completion và event-driven Supervisor | request_changes → repair revision → approved → integrate trong completion/loop tests |

Source modules trong `backend/src/modules/supervisor`; tests trong
`backend/tests/unit` ngoại trừ `backend/tests/integration/automatic-review-source.test.js`.

## Verification và giới hạn — 2026-10-14

- Focused changed-scope run: **96 tests pass, 0 fail**, gồm 3 integration tests với Git
  thật và pipeline E2E dùng provider/store fixtures; không gọi provider thật.
- Ticket schema compile bằng Ajv2020; 4 policy hợp lệ + 4 policy không hợp lệ đúng kỳ vọng.
- Scoped ESLint, `git diff --check`, file size ≤250 dòng được kiểm tra riêng.
- Runtime local Node **18.19.1**, trong khi backend yêu cầu **≥22.5.0**.
  Authority transaction đã kiểm chứng bằng fixture; chưa xác minh với native
  `node:sqlite`/SQLite production trong môi trường này.
- Test baseline `review-worker.test.js` có assertion cũ về `.reviewer` của
  `createTicketWorkspaceRuntime`, trong khi HEAD trả `{executors}`; không sửa
  regression ngoài phạm vi này, không tính nó vào run 96 tests.
- Chưa chạy full suite, chưa dispatch ticket/provider thật, chưa commit/push.
  Trước rollout production cần gate SQLite trên Node được hỗ trợ và provider E2E
  theo ticket/manifest/approval hợp lệ; test fixtures không thay thế gate đó.

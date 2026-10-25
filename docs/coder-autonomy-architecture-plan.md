<!-- Architecture plan: phân tách autonomy nội bộ của Coder khỏi guardrails bảo mật/nghiệm thu, dựa trên khảo sát runtimeForge. -->
# Plan: Coder autonomy vs governance boundaries

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Báo cáo nội bộ trước đây ("6 gate cứng") bị sai: một số gate không thực sự ràng buộc Coder trong production, còn một số gate lại chặn đúng đường thoát hợp lệ (`needs_context`). Điều này làm mờ ranh giới giữa "Forge cung cấp service cho agent" và "Forge can thiệp sâu cách agent làm việc", vi phạm nguyên tắc 3-4 mà owner đã nêu.
- **Kết quả:** Kiến trúc hiện tại được ghi nhận chính xác để các ticket sau (1) không siết thêm trần theo loại hay deadline pre-edit cho Coder, (2) mở đường `needs_context` khi Coder đã sửa đổi nhưng vẫn cần owner/architect bổ sung ngữ cảnh, và (3) giữ nguyên các guardrails bảo mật/nghiệm thu thật sự cần thiết.
- **Giá trị:** Coder được tự do suy luận và chọn giải pháp kỹ thuật trong ticket boundary; Node giữ đúng vai trò điều phối và bảo vệ system boundaries, không chuyển gate kỹ thuật thành human approval giả.

## 2. Phạm vi

### In scope

- Ghi nhận facts về đường Coder production, đối chiếu từng gate "được cấu hình" với "được áp dụng".
- Đề xuất điều chỉnh semantics của `report_done` precondition để `needs_context` là đường thoát hợp lệ khi chưa commit.
- Ghi rõ các guardrails bắt buộc phải giữ nguyên (root containment, review gate, README prerequisite, allowed manifest).
- Nêu rủi ro compatibility và cách kiểm chứng outcome.

### Out of scope

- Thay đổi schema ticket, workflow JSON, file access policy, hoặc thêm gate mới.
- Sửa Reviewer capability (`coder-reviewer-capabilities.js`) hay runtime của các agent khác.
- Bỏ `COMMIT_MISSING` đối với `report_done(status="pass")`.
- Sửa code hoặc thêm test trong tài liệu này; đây chỉ là plan theo rulebook.

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc bắt buộc:**
  - Root containment và `allowed_file_paths` do SL/ticket cấp; Coder không tự mở manifest.
  - Reviewer gate và `run_check` / `commit_changes` verification không được hạ xuống human-approval.
  - README prerequisite (`CODER_RULES_REQUIRED`) vẫn là gate runtime — xoá không đổi được hành vi wrapper.
- **Hướng đề xuất (chi tiết để SL quyết định):**
  - Trong `ticket-resume.js` wrapper, đổi điều kiện thành `status !== "blocked" && status !== "needs_context"` khi gọi `assertCommitBeforeReport`; `needs_context` được coi là "dừng an toàn" giống `blocked` vì bản chất nó là escalate lên owner/architect.
  - Không đặt lại `discovery_candidate_calls/search_calls/read_calls` cho Coder production path (`selected.role === "coder" && !labMode`), vì đã được `assertDiscoveryBudget` bỏ qua khi null.
  - Giữ `discovery_budget` (tổng), `context_budget { max_bytes: 1_000_000, max_calls: 12 }` (đếm theo distinct tool kind) vì chúng là safety valve đã được test.
- **Dependency thật sự:** Không có; plan này chỉ ghi nhận hành vi hiện tại và đề xuất một thay đổi semantics nhỏ.
- **Quyết định chưa chốt:** `needs_context` có nên vẫn yêu cầu commit khi đã có thay đổi, hay được miễn tuyệt đối như `blocked`? Khuyến nghị miễn tuyệt đối vì `needs_context` mang semantics "dừng để hỏi", và resume prompt đã đưa `changedPaths` vào context.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `backend/src/modules/supervisor/nodeforge-task-executors.js` (2 branch: `claude-sdk` và `codex-sdk`) | Set `discovery_*_calls: undefined` khi `role === "coder" && !labMode`. | Source, dòng 49–55 và 121–127; mức cao. |
| `backend/src/modules/supervisor/ticket-complexity-profiles.js` | `edit_must_start_by_call: null` cho cả 3 profile; `escalation_enabled: true`; `EXPLORATION_STREAK_LIMIT = 3`. | Source; mức cao. |
| `backend/src/tools/exploration-state.js` `assertDiscoveryBudget` | Per-type gate chỉ bật khi limit là integer; `edit_started` xoá hoàn toàn enforcement. | Source; mức cao. |
| `backend/src/modules/governance/runtime-tool-governance.js` `dispatch` | `commit_changes`, `push_commit`, `report_done`, `respond_to_review` bypass retrieval reserve; discovery gate chạy trước tool execute. | Source; mức cao. |
| `backend/src/modules/governance/runtime-tool-governance-state.js` | `max_calls` tính theo distinct tool kind (`used_tool_calls`), không phải tổng call. | Source; mức cao. |
| `backend/src/modules/supervisor/ticket-resume.js` `assertCommitBeforeReport` | `report_done` block nếu `status !== "blocked"`; `needs_context` vì thế cũng bị chặn khi có `changedPaths` chưa commit. | Source; mức cao. |
| `backend/src/tools/agent-report-tool.js` | `status: "needs_context"` throw `CODER_NEEDS_CONTEXT` sau khi persist report, nhưng wrapper chặn trước đó. | Source; mức cao. |
| `backend/src/modules/supervisor/ticket-read-cache.js` | `READ_REPEATED` chỉ chặn `read_file` trùng path+window, invalidate bằng `forgetRead` khi edit. | Source; mức cao. |
| `backend/src/tools/tool-authorization.js` | Coder mặc định blocked path `docs/` cho write; read `docs/` luôn được. | Source; mức cao. |
| `workflows/agents/architecture/README.md` | Rulebook xác nhận SL được đổi implementation nhưng không đổi scope/guardrail. | Source; mức cao. |
| Test `runtime-tool-governance.test.js:71–136` | Verify total exhaustion, escalation, per-type default cho non-Coder. | Test file; chưa chạy. |
| Test `coder-unified-forge-tools.test.js:62–64` | Verify per-type limit null nhưng total budget integer cho Coder. | Test file; chưa chạy. |

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Báo cáo kiến trúc ghi nhận đúng: Coder production không bị per-type ceiling hay pre-edit deadline. | Tài liệu này được duyệt, không còn tuyên bố "6 gate đang chặn Coder". | — |
| O2 | `report_done(status="needs_context")` có thể gọi mà không cần commit trước. | Unit/integration test chứng minh: `changedPaths` non-empty + `needs_context` → tool persist report, throw `CODER_NEEDS_CONTEXT`, không throw `COMMIT_MISSING`. | Không thay đổi hành vi `pass` hoặc `blocked`. |
| O3 | Guardrails bảo mật/nghiệm thu giữ nguyên. | `README` prerequisite, root containment, review gate, commit-before-report cho `pass` vẫn được test chứng minh không đổi. | — |
| O4 | Không mở rộng phạm vi sửa code ngoài `ticket-resume.js` (và test liên quan) nếu owner approve O2. | Manifest ticket sau giới hạn trong file wrapper và các test cho `assertCommitBeforeReport`. | SL quyết định tên/số lượng ticket cụ thể trong boundary. |

**Gợi ý delivery (không bắt buộc):** SL có thể tạo một ticket nhỏ cho O2 (đổi điều kiện wrapper + test), còn lại O1/O3 tự chứng minh bằng tài liệu và test sẵn có; O4 chỉ ràng buộc khi ticket O2 được lập.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| `needs_context` được miễn commit có thể cho phép Coder bỏ dở worktree với file chưa commit. | Minor | `buildResumePrompt` đã liệt kê `Files already changed in the worktree` và yêu cầu `read_file` để verify. | SL/architecture: chấp nhận vì semantics của `needs_context` là "dừng hỏi", không phải "sẵn sàng review". |
| Báo cáo cũ về gate không khớp runtime production. | Major | Đã đối chiếu từng gate qua executor wiring và `assertDiscoveryBudget`. | AM: plan này ghi nhận corrected facts; SL cần giữ nguyên cho ticket sau. |
| `context_budget.max_calls` đếm theo distinct tool kind, không tổng call. | Minor (dễ hiểu lầm) | Source `runtime-tool-governance-state.js:28–32`. | SL/architecture: khi cần siết, phải mô tả đúng semantics này để tránh over-restrict. |
| Có gate nào khác chặn `needs_context` chưa khảo sát? | Assumption | Wrapper `ticket-resume.js` là đường đã kiểm tra; `report_done` bypass `reserveRetrieval` trong `dispatch`. | SL cần xác minh thêm integration path `production-runtime.js` trước khi sửa. |
| README prerequisite vẫn còn hiệu lực cho mọi resume? | Fact | Wrapper xoá `state.coderRulesRead = false` khi reset session; `assertCommitBeforeReport` chỉ áp cho non-blocked. | Không xử lý ở plan này. |

## 7. Acceptance criteria của plan

- [ ] Facts repository-specific có evidence file/symbol cụ thể; assumptions và câu hỏi mở được tách rõ.
- [ ] Không yêu cầu human chọn lại chi tiết implementation SL có thể tự quyết.
- [ ] Guardrails bảo mật và review/verification gates giữ nguyên; chỉ semantics của `assertCommitBeforeReport` là candidate thay đổi, và đó là escalation semantics hợp lệ, không phá acceptance cho `pass`.
- [ ] Outcome O2 có acceptance quan sát được bằng test.
- [ ] Không áp đặt mutable-file manifest; SL sẽ chốt ticket contracts và mapping O1–O4.
- [ ] Không có tuyên bố "đã approve" cho tới khi human xác nhận identity/revision/SHA-256 theo contract hiệu lực.

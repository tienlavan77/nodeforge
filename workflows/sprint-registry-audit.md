<!-- Audit tài liệu launch recovery và mức sẵn sàng Sprint Plan; không phải verdict implementation hoặc quyền dispatch. -->
# Sprint Registry — audit tiến độ launch recovery và Sprint Plan

**Ngày audit:** 2026-10-09 (UTC).
**Vai trò:** Architecture Manager; ghi nhận evidence, boundaries và handoff. SL sở hữu Sprint Plan/delivery; Reviewer nghiệm thu implementation độc lập.
**Kết luận:** batch sửa fixture + kiểm chứng lại đã hoàn tất theo báo cáo và sẵn sàng review; full recovery R1–R6 chưa được nghiệm thu. Các tài liệu đã đọc chưa đủ chứng minh SL đã tạo Sprint Plan/forecast hợp lệ.

## 1. Evidence và giới hạn kiểm tra

Đã đọc bằng Forge:

| Tài liệu | SHA-256 tại thời điểm đọc |
| --- | --- |
| `workflows/agents/architecture/README.md` | `8b3b25788f3f1167c9cc495ffb15c8e17cbd3434f6851f842d2c00c8dc92281d` |
| `workflows/report-sprint-registry-cutover-launch-recovery.md` | `dc62c4635cf75037d7560c9625cc4c32eba547592b332e8a7e3e5e0f76a9c292` |
| `workflows/plan-sprint-registry-cutover-execution-recovery.md` | `80cbcae0d1b81e5c4516a313c0f504cc058556e827f5c68557dc95196961eba2` |

Audit này chỉ đối chiếu tài liệu. Chưa đọc source/test bytes hiện tại, đối chiếu source hashes, lấy raw run evidence, xác minh runtime Sprint Plan/approval receipt hoặc chạy tests. Các trạng thái implementation/PASS dưới đây là **Coder/service được báo cáo**, không phải kết quả tái kiểm chứng của Architecture. Không dùng tài liệu bên ngoài vì không cần cho việc ghi nhận tiến độ repository này.

## 2. Đã làm tới đâu?

| Hạng mục | Evidence trong báo cáo launch recovery | Trạng thái audit |
| --- | --- | --- |
| Recovery khi còn launch claim | Mục 1: guard chặn checkpoint/terminal-based release occupancy và pending resume khi còn retained claim | Có implementation được báo cáo; chưa có nghiệm thu độc lập |
| Registry submission / individual RUN | Mục 2: reject missing dependency intent, ngăn bypass bằng `direct_code`, capture expectations khi có authoritative Sprint basis | Đã xử lý một phần; chưa chứng minh mọi consumer/non-empty production path |
| Restart với occupancy thật | Mục 7–8: SQLite occupancy thật, process Node mới chạy recovery hai lần; retained-claim cases và no-claim controls | Có witnesses trong batch focused PASS được báo cáo |
| Queue compatibility | Mục 7–8: uncaptured handoff, retry/dead-letter/ack, expired lease, captured quarantine và fairness | Có witnesses trong batch focused PASS được báo cáo |
| Fixture Registry/direct-code/legacy | Mục 8: fixture đã sửa và chạy lại | **Hoàn tất việc kiểm chứng lại; không còn blocker fixture chưa rerun** |
| Independent review / full recovery | Mục 6–8 còn các gates mở; chưa có Reviewer verdict | **Chưa nghiệm thu R1–R6 hoặc full cutover** |

### Focused PASS xác nhận trong mục 8

- Run: `VERIFY-RUN-aa17d26f-770c-462e-b753-2289621e8eb7`.
- Thời điểm: `2026-10-09T03:48:25.185Z`.
- Focused check **6 file PASSED**, exit `0`, `ready_for_review: true`.
- Command được dẫn từ mục 7 gồm persistent occupancy recovery, actual occupancy regression, queue compatibility, launch recovery, execution-fencing fixtures và dispatch recovery.
- Không chạy full suite. Service chưa expose raw TAP/stdout, concrete Node version hoặc atomic source-run bundle; không suy ra counts hay independent acceptance.
- Các lần FAIL trước giữ nguyên identity và kết quả; PASS mới không ghi đè lịch sử hoặc được gán cho source cũ.

**Quy tắc handoff:** chuyển batch này sang Reviewer. Không yêu cầu chạy lại fixture chỉ vì wording cũ; chỉ xem xét rerun khi bytes thay đổi hoặc có lỗi evidence cụ thể.

## 3. Gates còn mở để đóng recovery

| Outcome / boundary | Phần chưa được đóng theo tài liệu | Trách nhiệm tiếp theo |
| --- | --- | --- |
| R1/R2 — dependency/admission/continuation | Non-empty dependency intent qua actual production paths; admission/continuation và execution-only orphan recovery | SL lập coverage, ticket contracts và verification; Reviewer xác minh |
| R3 — event/projection/waiter | Projection/waiter repair, missed event, restart/replay và liveness disposition | SL tổ chức delivery trong guardrails; escalate thay đổi public policy |
| R4 — side-effect fencing | Guard hiện tại là đọc trước hành động, chưa phải write-time/atomic fence; claim có thể thay đổi trong await/release | SL đề xuất protocol; Architecture/human chốt nếu vượt boundary |
| R5 — consumer convergence | Producer, worker, review-resume không retained claim, revision reader và compatibility inventory chưa được chứng minh đầy đủ | SL inventory và mapping witness/retirement gate |
| R6 — source-bound acceptance/forecast | Raw evidence bundle truy xuất được, source snapshot/dirty manifest đầy đủ, environment/Node version cụ thể, Reviewer độc lập và SL forecast | SL/Reviewer cung cấp evidence và forecast; human chốt artifact handoff khi cần |
| Provider disposition / availability | Retained claim chặn release/retry/replacement; chưa có provider-stop proof hoặc automatic recovery deadline | Giữ safety boundary; decision owner chốt semantics/authority cần thiết |
| O1–O7 carry-forward | Authority/UI/handoff/migration/retirement gates theo plan mục 5 vẫn phải theo dõi riêng | SL giữ coverage ledger; không đóng bằng focused PASS hoặc riêng R1–R6 |

Đây là các acceptance gaps được tài liệu ghi nhận, không phải khẳng định mọi implementation tương ứng đều chưa tồn tại hoặc có lỗi production.

## 4. Audit việc tạo Sprint Plan

**Chưa xác nhận SP hoàn tất.** Báo cáo launch recovery không có mapping từng criterion → ticket → owner → dependency/blocker → evidence → estimate/forecast.

Plan được dẫn chiếu vẫn ghi **Draft**; mục 7 chưa đánh dấu hoàn tất exact human approval, SL source-bound SP/coverage/forecast và independent Reviewer acceptance. Điều này không chứng minh runtime chưa có SP: audit này chưa truy xuất runtime artifact hoặc approval receipt.

Để xác nhận một SP hợp lệ, SL cần cung cấp:

- Exact architecture/goal identity, revision và approval SHA-256 theo storage contract hiệu lực; không chuyển approval sang bytes mới.
- Coverage từng criterion R1–R6 và carry-forward gates, phân biệt việc đã có focused PASS, việc chờ review và phần còn mở; không tạo lại fixture rerun đã hoàn tất.
- Ticket contracts đủ objective, scope/boundary, compatibility, acceptance, dependencies và verification; một style hợp lệ, tối đa bốn mutable files/ticket theo rulebook.
- Dependency DAG và candidate paths dựa trên discovery; manifest không tự mở rộng scope.
- SV chịu trách nhiệm mỗi ticket, independent Reviewer, retry/escalation policy và evidence closure.
- Owner/capacity, estimates, blockers và forecast do SL lập; Architecture không tự hứa ETA hoặc ép số/tên ticket.

**Tạo SP không đồng nghĩa được RUN/dispatch.** Approval, admission và execution gates vẫn phải xác minh riêng.

## 5. Những câu trạng thái cần đồng bộ trong báo cáo gốc

Không sửa báo cáo gốc trong lượt audit này. Đề nghị người sở hữu báo cáo:

1. Mục 6: đánh dấu “Confirm corrected execution-fencing fixtures…” đã hoàn tất và dẫn mục 8.
2. Mục 4–5: gắn rõ “not rerun” / “overall check remains FAILED” là trạng thái lịch sử; mục 8 supersede riêng pending rerun, không xóa FAIL.
3. Sắp lại thứ tự mục 6–8 hoặc thêm chỉ dẫn trạng thái mới nhất để tránh hiểu nhầm mục 8 đứng trước 7 và 6.

Không mở lại việc đã hoàn tất chỉ vì câu chữ cũ. Mục 7 đã có câu dẫn sang mục 8 để supersede trạng thái fixture chưa rerun.

## 6. Handoff và điều kiện kết thúc

- **SL:** chốt người nhận review và mốc trả verdict cho batch PASS; lập coverage/owner/dependency/blocker/estimate/forecast cho phần recovery còn mở.
- **SV/Reviewer:** quản lý review độc lập theo ticket contract; đối chiếu source snapshot/hashes và raw evidence, trả verdict từng criterion. Coder PASS chưa đủ để accepted.
- **Architecture/human:** xử lý quyết định vượt boundary, public semantics, incompatibility và authority; không tự approve, dispatch hoặc review implementation mình sở hữu.
- **Đóng execution remediation:** mọi R1–R6 được Reviewer xác minh và decisions cần thiết đã chốt.
- **Đóng full cutover:** mọi O1–O7 được nghiệm thu và human decisions/rollout gates đạt; focused PASS không thay thế điều kiện này.

**Giới hạn thao tác lượt này:** chỉ tạo audit nội bộ tại `workflows/sprint-registry-audit.md`; không sửa implementation hoặc báo cáo gốc, không chạy test, commit/push, approve, production RUN, migration, rollout hay retire legacy.

## Giai đoạn 6 — Report & thông báo owner

> Nối vào đúng điểm `4a-5` để lại: sau khi `updateStatus(done)` (merge thành công), Node có đủ 3 nguồn dữ liệu (report agent tự khai từ `2b-3`, kết quả verify từ `4b-4`, lịch sử commit từ git) — Giai đoạn này chỉ là **gộp 3 nguồn đó lại và ghi ra file**, không cần thêm nguồn dữ liệu mới nào.

### 6a — Build & ghi report

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 6a-1 | Lưu `verify_result` vào storage ngay khi `runVerification` (4b-4) chạy xong | ☐ Chưa làm | **Lỗ hổng cần vá trước**: hiện `4b-4` chỉ trả kết quả cho `4a-5` dùng ngay (quyết định merge hay không), chưa lưu lại — nếu không lưu, report cuối không có gì để đọc. Thêm `storage.save('task/<id>/verify_result', result)` (0b-2) vào cuối `4b-4`. |
| 6a-2 | `getCommitsForTask(task_id)` | ☐ Chưa làm | Lấy từ `git log` trên `main` SAU KHI đã merge (không phải trên branch — branch đã bị xoá ở `4a-5`). Vì merge dùng `--no-ff` (4a-2), lịch sử round vẫn nằm nguyên dưới merge commit — lọc theo message pattern `[<task_id>]` đã gắn từ lúc commit từng round (0c-3). |
| 6a-3 | `buildFinalReport(task_id)` | ☐ Chưa làm | Gộp: ticket (0d) + `report` agent tự khai (đã lưu lúc `2b-3` nhánh `completed`) + `verify_result` (6a-1) + `files_changed` từ `getCommitsForTask` (6a-2, nguồn git thật — KHÔNG lấy lại từ lời agent khai). |
| 6a-4 | Đối chiếu `criteria_check` (agent khai) với `verify_result` (Node đo) → field `node_verified` | ☐ Chưa làm | MVP: verify tầng 1+2 chỉ cho kết quả tổng (build pass/fail), không map được 1-1 vào từng tiêu chí cụ thể — tiêu chí nào liên quan trực tiếp "không lỗi build/syntax" thì gán `node_verified` theo kết quả `verify_result.pass`; tiêu chí không đo được ở tầng 1-2 (vd yêu cầu về UI/hành vi) → để `node_verified: null`, không suy diễn. |
| 6a-5 | `saveReport(task_id, report)` | ☐ Chưa làm | Lưu vào storage nội bộ (0b-2, `task/<id>/final_report`) — bản ghi máy đọc lại được, tách khỏi bản người đọc ở 6a-6. |
| 6a-6 | `writeReportFile(task_id, report)` | ☐ Chưa làm | Format Markdown, ghi ra `reports/<task_id>.md` trên disk thật — đây là file owner thực sự mở ra xem, khác `saveReport` (6a-5) chỉ để máy dùng lại. |
| 6a-7 | Gắn `buildFinalReport → saveReport → writeReportFile` vào `4a-5`, ngay sau `updateStatus(done)` | ☐ Chưa làm | Điểm nối duy nhất — không tạo luồng riêng, chỉ nối thêm vào cuối nhánh `completed` đã có. |
| 6a-8 | Ghi report cả cho trường hợp dừng bất thường (`merge_conflict`, `needs_human_review`) | ☐ Chưa làm | Không chỉ nhánh `done` mới có report — task dừng ở `4a-3` (conflict) hay ở guard round counter (3a-4) cũng nên có 1 bản ghi ngắn (chưa cần đủ 3 nguồn như 6a-3, chỉ cần lý do dừng + trạng thái tại thời điểm đó) để owner biết vì sao task treo mà không phải lục log tay. |

### 6b — Nâng cấp kênh báo (để sau)

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 6b | Webhook/Slack | ☐ Để sau | Chỉ làm nếu thấy việc tự vào đọc `reports/<task_id>.md` không đủ chủ động — khi làm, chỉ cần 1 hàm `notifyOwner(task_id, report)` gọi SAU `6a-7`, tái dùng đúng report đã build, không build lại. |

**Thứ tự làm khuyến nghị:** `6a-1` trước tiên (vá lỗ hổng lưu verify_result — nếu bỏ qua, mọi thứ sau đều thiếu dữ liệu) → `6a-2/6a-3/6a-4` (build report, test bằng cách gọi tay trên 1 task đã merge xong thủ công) → `6a-5/6a-6` (lưu + ghi file) → `6a-7` (nối vào `4a-5`) → `6a-8` (mở rộng cho case dừng bất thường, làm sau cùng vì là nhánh phụ).

---


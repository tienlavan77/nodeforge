<!-- Ma trận bằng chứng và khoảng trống còn lại của tạm dừng/phục hồi chat Architecture Manager. -->
# Kiểm chứng pause/resume Architecture — NO-GO

**Ngày:** 2026-10-06. **Plan:** `workflows/plan-pause-resume-architecture.md`, SHA-256 `613987d85babca64b9ba8f8b9d0a1a1bd134e30687d5482e2e2d8e42cd007988`. Owner đã xác nhận SHA trong conversation; dòng trạng thái trong plan là văn bản gốc, không sửa vì sửa sẽ đổi SHA. Approval plan không phải RUN/dispatch hay nghiệm thu.

**Check tập trung:** `VERIFY-RUN-99020be9-b2c3-4259-8d22-9f88b4e1ea5f`; `node --test backend/tests/unit/architecture-execution.test.js backend/tests/unit/owner-execution-checkpoint.test.js ui/nextjs/tests/architecture-execution.test.js`; exit code `0`, trạng thái `passed`. Run không có browser, real HTTP, process-crash hay Git remote. Không dùng unit/static test để tuyên bố đạt A1–A4.

| Outcome | Evidence đã có | Chưa có / điều kiện mở gate |
| --- | --- | --- |
| A1 — Pause, trạng thái bền vững | Checkpoint Architecture riêng, persisted tool boundary; nút Pause và Esc x2 cùng gọi decision; unit checkpoint và static UI thuộc run trên. | Browser desktop/mobile + reload/process restart; IME, dialog, rename và phím giữ cần kiểm thử tương tác thực; kiểm tra chống gửi trùng ở network layer. |
| A2 — Reconcile, không replay | Trước mutation Node lưu hash trạng thái ban đầu và hash kết quả dự kiến (hoặc absence) mà không lưu nội dung; `manual_required` chỉ mở khi runner ghi đã dừng, không có mutation active và file thực tế khớp dự kiến. Unit run trên kiểm chứng mismatch, missing marker, write/delete thành công, receipt/audit và chặn replay. | Write không đủ evidence, trạng thái giống trước/sau và process chết trước dấu dừng vẫn bị chặn; cần scenario crash sau write/trước receipt trên process riêng, edit_diff, nhiều lần mutation và provider thread loss thật. Không chấp nhận owner-supplied checksum làm proof. |
| A3 — Quyền, lease/race | Route áp token của project owner cho Architecture, so project; control lọc theo agent/nguồn message; unit route negative và stale active mutation thuộc run trên. Architecture tool set không có Git, source write hay dispatch. | Test HTTP thực cho token/project/conversation/agent và hai process đồng thời; lease hết giữa file write và process cũ sống vẫn phải bị chặn. Dấu dừng chỉ được ghi sau provider execution settled. |
| A4 — Governance, audit | Recovery chỉ ghi vào checkpoint runtime Architecture; không sửa plan, revision, SHA approval hay gọi RUN/dispatch. Receipt manual giữ actor, time và hash evidence. | Browser và integration để chứng minh governance end-to-end; human review từng acceptance criterion. Chưa có bằng chứng production acceptance. |

**Trạng thái:** NO-GO. Chỉ đề xuất GO sau khi có đầy đủ integration thực, race/crash, HTTP auth âm tính, browser e2e và audit governance; không tự động resume, approve hoặc dispatch. Chưa commit/push trong lượt triển khai này.

> Cả 2 guard đều là "chặn ở 1 điểm trung tâm" — không sửa nhiều nơi trong state machine, chỉ thêm 1 lớp kiểm tra trước hành động đã có sẵn (gửi request / đọc file / ghi file).

### 3a — Round counter (guard [3])

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 3a-1 | Thêm field lưu số round đã dùng theo `task_id` | ☐ Chưa làm | Không thêm vào schema ticket (0d-1) — đây là runtime state, không phải thuộc tính ticket. Lưu riêng, vd `storage.save('task/<id>/round_count', n)` (dùng lại 0b-2), hoặc field tạm trong bộ nhớ nếu chưa cần bền vững qua restart. |
| 3a-2 | `incrementRoundCount(task_id)` | ☐ Chưa làm | Đọc giá trị hiện tại, +1, ghi lại. |
| 3a-3 | `checkRoundLimit(task_id, maxRounds)` | ☐ Chưa làm | Trả `true/false`. Ngưỡng `maxRounds` để config, không hard-code (vd biến môi trường hoặc file config, mặc định 15). |
| 3a-4 | Gắn `incrementRoundCount` + `checkRoundLimit` vào `sendRequest` (1-3) | ☐ Chưa làm | Đây là **điểm trung tâm duy nhất** mọi request đi qua (task, code_needed, code_provide, usage_query...) — chặn ở đây, không chặn rải rác ở từng nhánh. Vượt ngưỡng → `updateStatus(task_id, 'needs_human_review')` (0d-2), ghi log, **không gọi** `claudeAdapter.call()`. |
| 3a-5 | Dọn 2 biến đếm tạm ở Giai đoạn 2 | ☐ Chưa làm | Xoá giới hạn thô ở 2a-5 (tối đa 5 lần) và 2b-4 (tối đa 3 lần continue) — thay bằng guard thật này, vì `checkRoundLimit` đã bao trùm mọi loại round, không cần đếm riêng từng loại. |

### 3b — Protected path (guard [4])

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 3b-1 | Định nghĩa `PROTECTED_PATTERNS` (danh sách regex) | ☐ Chưa làm | `.env`, `.env.*`, `wp-config.php`, `config/secrets/**`, `.git/**` — để trong file config riêng, không hard-code trong logic, dễ thêm bớt sau. |
| 3b-2 | `isProtectedPath(path)` | ☐ Chưa làm | Hàm thuần, test độc lập được (không phụ thuộc fs/git) — input path, output boolean. |
| 3b-3 | Viết `guardedRead(path)` — wrap quanh `fs.readFileSync`, chặn bằng 3b-2 | ☐ Chưa làm | Trả `{content: null, exists: false, denied: true, reason: "..."}` nếu path bị chặn, thay vì đọc thật. |
| 3b-4 | Viết `guardedWrite(path, content)` — wrap quanh `fs.writeFileSync` + `git.commit`, chặn bằng 3b-2 | ☐ Chưa làm | Nếu bị chặn → throw lỗi rõ ràng, KHÔNG ghi, KHÔNG commit — patch dừng lại, không được âm thầm bỏ qua file đó rồi patch tiếp phần còn lại. |
| 3b-5 | Thay `fs.readFileSync` trực tiếp trong 1-5a và 2a-4 bằng `guardedRead` | ☐ Chưa làm | Đây là chỗ đổi thật trong code đã viết ở Giai đoạn 1/2 — không phải thêm mới, mà thay hàm đọc file cũ bằng bản có guard. |
| 3b-6 | Thay `fs.writeFileSync` trực tiếp trong 1-5b bằng `guardedWrite` | ☐ Chưa làm | Tương tự 3b-5, áp cho nhánh patch. |
| 3b-7 | Test case: agent (qua mock 1-7) yêu cầu đọc `.env` | ☐ Chưa làm | Xác nhận `code_provide` trả về `denied: true`, không lộ nội dung thật — test bằng mock, không cần gọi Claude thật. |

> **Ghi chú tích hợp với File Service (thiết kế riêng, chưa nối vào pipeline):** khi File Service (đường đọc filesystem duy nhất theo thiết kế Code Index 12 bước) được nối vào pipeline sau này, `readForIndex()` của nó nên gọi lại đúng `isProtectedPath()` (3b-2) thay vì tự viết lại danh sách chặn — tránh 2 nơi định nghĩa "vùng cấm" khác nhau rồi lệch nhau theo thời gian.

**Thứ tự làm khuyến nghị:** `3a` và `3b` độc lập nhau, làm song song được. Trong `3b`, làm `3b-1→3b-4` (viết hàm guard) trước, rồi mới `3b-5/3b-6` (thay thế trong code cũ) — tách rõ "viết guard" và "áp guard vào chỗ đang dùng" để dễ test riêng từng phần.
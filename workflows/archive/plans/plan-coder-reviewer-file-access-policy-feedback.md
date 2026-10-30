<!-- Ghi nhận đánh giá kỹ thuật của System Engineer về việc tách quyền đọc và ghi của Coder và Reviewer. Tài liệu đề xuất các bất biến phân quyền và bằng chứng nghiệm thu nhằm giảm chặn nhầm mà không mở rộng quyền sửa hoặc làm sai lệch nguồn dữ liệu đánh giá. -->
# Phản hồi: Kế hoạch quyền truy cập dự án của Coder và Reviewer

**Ngày:** 2026-10-22

**Người đánh giá:** System Engineer

**Tài liệu đối chiếu:** `workflows/plan-coder-reviewer-file-access-policy.md`

**Trạng thái:** Góp ý kỹ thuật; không phải phê duyệt kế hoạch, cấp grant hoặc cho phép triển khai.

## 1. Đánh giá tổng quan

Đồng thuận với hướng **đọc rộng có kiểm soát, ghi hẹp theo ticket**. Kế hoạch đã giữ đúng các nguyên tắc quan trọng:

- Tách quyền đọc khỏi quyền ghi, không dùng `project_wide_access` làm lối tắt.
- Protected-path policy ưu tiên từ chối; manifest không hợp thức hóa đường dẫn bị cấm.
- Reviewer không sửa source; findings và receipts đi qua dịch vụ Node.
- Không tự nâng quyền khi resume, không thay approval hoặc revision đã khóa.
- Đồng bộ prompt, enforcement và tests thay vì chỉ sửa chỉ dẫn cho agent.

Đề nghị bổ sung năm điểm dưới đây trước khi chốt delivery. Không cần chốt tên field/helper ở cấp plan; cần chốt các bất biến bảo mật và bằng chứng nghiệm thu.

## 2. Các góp ý cần làm rõ

### F1. Bao phủ đường truy cập ngoài các tool đã bind — ưu tiên cao

**Khoảng trống:** Parity giữa provider/adapter chưa diễn đạt đủ rõ yêu cầu với SDK native tools, shell/subprocess và verification command, nếu execution có bật các đường này.

**Đối chiếu:** `backend/src/tools/engineering-tool-binding.js:40` kiểm tra path trực tiếp cho `read_file`, `read_lines`, `write_diff`, `edit_diff`; các tool khác phụ thuộc implementation và lớp enforcement riêng. Đây là phạm vi cần khảo sát, chưa phải bằng chứng có bypass.

**Đề xuất bổ sung O3/O5:**

- Lập danh sách đường truy cập thực tế theo role/provider/mode, gồm cả tool native và tiến trình con được phép chạy.
- Mỗi đường phải thực thi chính sách tương đương hoặc bị vô hiệu hóa; không dùng prompt làm ranh giới bảo mật duy nhất.
- Với cùng một đường dẫn bị cấm, kiểm tra không thể đọc/ghi qua đường khác khi tool đọc/ghi chuẩn đã từ chối.
- Quyền verification tiếp tục tách biệt; read grant không cấp thêm command hoặc quyền ghi cho tiến trình con.
- Đường không hỗ trợ phải được ghi rõ và từ chối an toàn, không fallback sang quyền rộng hơn.

### F2. Chốt snapshot cho Reviewer đọc ngoài diff — ưu tiên cao

**Khoảng trống:** O4 yêu cầu đúng revision/hash nhưng chưa chốt nguồn caller/consumer ngoài diff. Không được đánh giá bằng hỗn hợp file thay đổi ở commit A và caller ở working tree B mà không nhận diện sự khác biệt.

**Đối chiếu:** `backend/src/modules/supervisor/reviewer-forge-tools.js:58` dùng evidence cho file có trong evidence; nhánh file không có hoặc đã đánh dấu xóa có thể fallback sang cache hoặc filesystem. Cần khảo sát thêm các lớp binding trước khi kết luận tác động đến verdict.

**Đề xuất bổ sung O4:**

- Source dùng làm căn cứ verdict phải thuộc cùng review snapshot, kể cả file ngoài diff; đường dẫn được đọc vẫn phải qua safe read policy.
- Nội dung, kết quả search, index và cache phục vụ review phải có provenance tương thích với snapshot đó.
- Nếu cho đọc live context, phải phân biệt với evidence của revision đang review; không âm thầm dùng live context thay snapshot.
- Kiểm tra file ngoài diff bị sửa/xóa sau khi tạo evidence, cache sai revision và working tree thay đổi trong lúc review.

### F3. Quy tắc legacy grant phải xác định được — ưu tiên cao

**Khoảng trống:** Câu “giữ quyền legacy hợp lệ hoặc báo lỗi/reconcile” cần tiêu chí phân nhánh, tránh mỗi consumer hiểu khác nhau.

**Đối chiếu:** `backend/src/tools/tool-authorization.js:35` hiện trả về cho phép khi thiếu cả hai mảng scope. Thay đổi helper dùng chung phải kiểm tra consumer, không thể đồng nhất mọi context thiếu scope với legacy hợp lệ.

**Đề xuất bổ sung O1/O5:**

- Context theo contract mới thiếu hoặc sai grant: từ chối rõ ràng.
- Context legacy: chỉ dùng policy tương thích khi nhận diện được version/provenance tin cậy do Node quản lý.
- Không xác định được nguồn gốc/version: từ chối hoặc reconcile; không suy ra legacy chỉ vì thiếu field.
- Migration/resume không được tự tạo read grant mới hoặc mở rộng write authority từ checkpoint cũ.
- Test riêng context mới, legacy hợp lệ, context không xác định và dữ liệu checkpoint bị chỉnh sửa.

### F4. Phân loại governance docs phải có nguồn thẩm quyền

**Khoảng trống:** Plan đã ghi nhận rủi ro nhưng cần đưa nguồn phân loại thành điều kiện nghiệm thu, không chỉ là công việc khảo sát.

**Đề xuất bổ sung O2:**

- Xác định nguồn policy có thẩm quyền để phân biệt docs triển khai với governance/approval/architecture docs.
- Agent không tự phân loại để mở quyền; không chỉ dựa vào prefix `docs/` hoặc tên file.
- Exact file grant và manifest vẫn không vượt protected/governance policy.
- Test docs triển khai được cấp ghi, governance docs nằm trong manifest vẫn bị chặn và prefix grant không cấp quyền ghi toàn thư mục.
- AM/owner xử lý xung đột theo thẩm quyền; SL lựa chọn cách biểu diễn và truyền policy trong guardrails đã duyệt.

### F5. Kiểm tra đổi path, cache và thu hồi quyền

**Khoảng trống:** O3 đã có traversal/symlink và O5 đã cấm tăng quyền, nhưng cần kiểm chứng biến động giữa các lần truy cập.

**Đề xuất bổ sung O3/O5:**

- Kiểm tra alias và chuẩn hóa đường dẫn, prefix gần giống, cùng symlink bị thay giữa bước kiểm tra và đọc/ghi; không để kiểm tra một đối tượng rồi truy cập đối tượng khác.
- Cache/index tạo dưới grant cũ không được bỏ qua authorization tại lần truy cập hiện tại hoặc làm lộ tên/snippet/nội dung đã bị thu hồi quyền.
- Resume khi grant bị thu hẹp/thu hồi phải từ chối hoặc reconcile theo policy đã chốt, không tiếp tục dùng quyền cũ chỉ vì checkpoint còn giữ grant.
- Làm rõ thời điểm policy thu hồi có hiệu lực đối với execution đang chạy; nếu cần đổi guardrail “giữ scope đã cấp”, quay lại AM/owner, không tự đổi khi triển khai.
- Negative tests phải có đối chứng đường dẫn hợp lệ để tránh đạt do chặn toàn bộ truy cập.

## 3. Handoff và bằng chứng đề nghị

| Góp ý | Outcome liên quan | Bằng chứng tối thiểu |
| --- | --- | --- |
| F1 | O3, O5, O6 | Ma trận đường truy cập thực tế và test allow/deny tại boundary của từng đường được bật. |
| F2 | O4, O6 | Test caller ngoài diff đổi sau snapshot, cache sai revision và nguồn dữ liệu phục vụ verdict. |
| F3 | O1, O5, O6 | Test contract mới/legacy/không xác định và resume không suy diễn quyền. |
| F4 | O2, O6 | Nguồn phân loại governance có thẩm quyền và test deny precedence dù có manifest/grant. |
| F5 | O3, O5, O6 | Test biến động path/cache và grant bị thu hẹp/thu hồi theo thời điểm hiệu lực đã chốt. |

Đây là yêu cầu bổ sung độ rõ của plan và coverage nghiệm thu, không phải yêu cầu mở rộng quyền, cấp shell tùy ý hoặc sửa toàn bộ hệ thống ngoài scope.

## 4. Kết luận và giới hạn đánh giá

- Đồng ý hướng kiến trúc; đề nghị làm rõ F1–F5 trước khi chốt delivery, đặc biệt đường truy cập native và snapshot đọc ngoài diff.
- Chủ thể có thẩm quyền cần chốt nguồn phân loại governance và semantics thu hồi quyền nếu còn thiếu hoặc mâu thuẫn với plan.
- Nhận xét dựa trên khảo sát tĩnh workspace; source references là tọa độ hiện tại, không phải evidence bất biến của một commit đã phê duyệt.
- Chưa chạy tests cho implementation hoặc xác minh provider live; không kết luận implementation đã đạt hay đã chứng minh tồn tại bypass.
- Phản hồi này không sửa plan gốc, không thay approval/revision, không dispatch và không triển khai policy.

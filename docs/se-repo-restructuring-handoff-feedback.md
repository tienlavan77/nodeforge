<!--
Ghi nhận phản hồi kỹ thuật của System Engineer về đề xuất tái cấu trúc kho mã nguồn để Architecture Manager chỉnh lại phạm vi, bằng chứng bảo toàn và điều kiện nghiệm thu trước khi thực thi.
Tài liệu đối chiếu bản handoff với mã nguồn và kiểm thử đã đọc, phân biệt công việc dọn tài liệu với việc di chuyển mô-đun vận hành, đồng thời liệt kê các điểm cần bổ sung để đánh giá hồi quy có căn cứ.
-->
# Phản hồi SE: Bàn giao tái cấu trúc repository

- Ngày đánh giá: 2026-10-29.
- Người nhận: Owner và Architecture Manager.
- Tài liệu được đánh giá: [se-repo-restructuring-handoff.md](se-repo-restructuring-handoff.md).
- SHA-256 bản được đánh giá: `4f946fa9df70abd0eccf720d3dc260170670374232db3d698ecaaaad6795651c`.
- Phương pháp: đọc tài liệu và đối chiếu source, cấu hình, test. Chưa chạy test trong lượt đánh giá; không có kết luận nghiệm thu hay phê duyệt thực thi mới.

## Kết luận

Hướng gom tài liệu lịch sử, chuẩn hóa tài liệu gốc và tổ chức source theo miền là hợp lý.
Bản handoff cần chỉnh phạm vi và bổ sung bằng chứng kiểm tra trước khi dùng làm chỉ dẫn thực thi toàn bộ.
Không xem việc sửa đường dẫn hoặc làm cho test chạy qua là đủ chứng minh bảo toàn hành vi và chất lượng truy xuất.

## 1. Tách phạm vi dọn tài liệu và tái cấu trúc source vận hành

**Vị trí:** mục 3 của handoff.

Sprint `SPRINT-NODEFORGE-99ba623d-r1-repository-governance` ban đầu loại trừ đổi tên, di chuyển hoặc tái cấu trúc module thực thi trong `backend/src/`.
Handoff thêm việc chuyển module trong `tools/`, `supervisor/`, hợp nhất `modules/agents/` và đổi tên registry.

Đề nghị ghi rõ đây là phạm vi mở rộng so với sprint cũ.
Tách phần refactor source thành hạng mục riêng có inventory, nhóm phụ thuộc, kiểm tra và điều kiện hoàn tất riêng.
Phản hồi này không tự cấp quyền mở rộng sprint hoặc thay đổi tiêu chí đã khóa.

## 2. Giữ nguyên marker tool-lab

**Vị trí:** mục 1.2, phần file log và file thử nghiệm lẻ.

Bỏ đề xuất có thể xóa `backend/tool-lab-target.txt`.
[Test cleanup hiện tại](../backend/tests/unit/repository-cleanup.test.js) tại dòng 74–85 đọc file thật, kiểm tra vị trí, nội dung và SHA-256.
Ngoài ra còn có tham chiếu trong `backend/src/modules/eval/eval-case-store.js` và `backend/src/tools/agent-report-tool.js`.

Đây là artifact cần bảo toàn theo O1; không phân loại là rác chỉ dựa vào tên file hoặc số lượng import.

## 3. Bỏ nhận định “rủi ro = 0” cho thay đổi runtime

**Vị trí:** bước 3.1.

`backend/src/bootstrap/index.js:8` đang import stream bridge từ `modules/agents/`.
Di chuyển bridge tác động đường nạp bootstrap; cần kiểm tra khởi tạo, chuyển tiếp sự kiện và hủy đăng ký listener, bao gồm redaction stderr.

Với ba module được gọi là dead code, cần kiểm tra exported symbols, import gián tiếp, dynamic loading, entrypoint và test consumer trước khi xóa.
Tìm kiếm tên file chưa đủ chứng minh không có consumer.
Nhận định dead code chưa được xác nhận đầy đủ trong lượt đánh giá này.

## 4. Sửa checklist kiểm tra và bằng chứng retrieval

**Vị trí:** mục 4.

- `pnpm --dir ui/nextjs test` hiện không có script tương ứng trong [ui/nextjs/package.json](../ui/nextjs/package.json).
  Cần chỉ rõ lệnh hoặc cơ chế discovery thực sự chạy toàn bộ test UI, kể cả thư mục con.
- Bổ sung các kiểm tra bắt buộc còn thiếu: root lint, typecheck, schema validation và Next.js build.
- Sau từng nhóm source, chạy kiểm tra hẹp phù hợp; sau khi tích hợp, chạy các gate bắt buộc của toàn bộ phạm vi.
- Lưu revision, môi trường, lệnh, kết quả và đường dẫn output cho mỗi lượt kiểm tra.
- Khi test fail, dùng cùng assertion và môi trường để đối chiếu baseline; không tự gọi lỗi cũ chỉ vì nằm ngoài file đang sửa.

[agent-discovery-baseline-comparison.test.js](../backend/tests/unit/agent-discovery-baseline-comparison.test.js)
là kiểm tra quy nguyên nhân hồi quy security giữa nguồn hiện tại và baseline cố định.
Nó không phải bằng chứng đánh giá chất lượng semantic retrieval trước và sau di chuyển.

Với retrieval, cần chạy baseline và bản sửa bằng cùng corpus, cấu hình và môi trường; lưu chỉ số cùng tiêu chí chấp nhận trước khi sửa.
Giữ benchmark có ý nghĩa: cập nhật mapping đường dẫn một cách minh bạch khi cần, không thay ground truth chỉ để nâng kết quả.
Re-export có thể bảo toàn import nhưng chưa chứng minh truy xuất tìm đúng phần triển khai.

## 5. Bổ sung inventory và tiêu chí bảo toàn nội dung

**Vị trí:** mục 1.1, mục 2 và bước 3.3.

Trước khi sửa hàng loạt, lưu trạng thái Git và inventory nguồn → đích kèm hash.
Với thay đổi ngoài phạm vi đang dở, lưu đủ bằng chứng trước/sau để đối chiếu việc bảo toàn.
Không dựng lại bằng chứng trước thay đổi từ cây đã chỉnh sửa.

Với tài liệu tách nhỏ:

- Lưu hash nội dung gốc, thứ tự các phần và mapping từng phần sang đích.
- Kiểm tra có thể khôi phục đầy đủ nội dung theo đúng thứ tự.
- Sửa liên kết tương đối, ảnh và consumer đọc file thật theo vị trí mới.
- Kiểm tra giới hạn 250 code_lines tại mọi đích mới hoặc được chỉnh sửa.
- Giữ fixture đường dẫn minh họa nếu không thực hiện truy cập file thật.

Với source, inventory phải bao gồm import tĩnh, import động, đường dẫn dựa trên vị trí file, fixture và consumer bên ngoài cụm.
Thực hiện từng nhóm, kiểm tra trước khi chuyển nhóm tiếp theo; xác định rõ cách hoàn nguyên riêng nhóm mà không ghi đè thay đổi ngoài phạm vi.

## 6. Đồng bộ phạm vi còn thiếu và hiện trạng đã sửa

- Mục 2.2 chưa liệt kê `docs/sprints/`, trong khi O2 của sprint cũ yêu cầu đưa thư mục này vào archive.
- Bổ sung O5 về pnpm nếu tài liệu được dùng để bàn giao toàn bộ sprint.
  Script [repair-npm-bin-links.mjs](../backend/scripts/repair-npm-bin-links.mjs) hiện đã dùng `../..` để tính gốc repo; cần ghi nhận đây là thay đổi đã có, cần kiểm chứng thay vì chỉ dẫn sửa lại.
- Nên phân biệt rõ trạng thái: đã sửa trong workspace, đã kiểm tra, chưa triển khai và chưa có bằng chứng.
- Quy tắc comment mục đích áp dụng cho file hoặc symbol mới; không yêu cầu thêm comment vào mọi file hiện hữu chỉ vì được biên tập.

## Đề nghị cập nhật handoff

Giữ phần dọn tài liệu theo phạm vi đã thống nhất; sửa yêu cầu marker và bổ sung phần pnpm.
Tách refactor source thành các nhóm độc lập có mapping và kiểm tra cụ thể.
Bổ sung inventory, bằng chứng nội dung, kết quả retrieval và các gate tích hợp trước khi tuyên bố hoàn tất.

<!-- Records the SE-only public SDK transcript behavior, storage contract and verification scope. -->
# System Engineer: event SDK trong conversation

## Phạm vi

- Chỉ `system_engineer` có transcript event đầy đủ từ SDK Codex và Claude/Anthropic trong khung chat System Engineer.
- AM, Sprint Leader, Coder, Reviewer giữ nguyên đường đi và giới hạn monitor hiện tại. Không thay đổi quyền tool, sandbox, giới hạn đọc source hay ngân sách tool.
- Monitor hiện có tiếp tục hoạt động độc lập; giới hạn số event của monitor không áp vào transcript conversation.

## Hành vi

- Event công khai được chuyển tiếp trước khi bị rút thành summary: command, arguments, output, kết quả, lỗi, thay đổi file, web search, lời agent và thông tin lifecycle công khai được hỗ trợ.
- Không cắt chuỗi, số field hay phần tử array trong payload SE; không thay source output bằng số byte. Chỉ giữ được nội dung SDK thực sự gửi, không khôi phục phần SDK/provider đã tự cắt.
- UI hiển thị trực tiếp câu lệnh và output như CLI, không dựng cây field–value, không thêm nhãn loại event hay header riêng cho event. Chuỗi nhiều dòng giữ nguyên xuống dòng; không diễn giải output thành HTML/Markdown và không đặt trần chiều cao output. Lỗi thực thi có mã thoát khác 0 được hiện sau output.
- Các envelope lifecycle thuần kỹ thuật không tạo dòng chat; payload event gốc vẫn được lưu đầy đủ để khôi phục. Text công khai, kết quả tool, lỗi và thay đổi file được trình bày thành nội dung đọc được; dữ liệu tool có cấu trúc không có bản text dùng JSON, không tóm tắt nội dung.
- Bản cập nhật text của cùng item trong cùng lượt SDK cập nhật tại chỗ. Các event tool riêng vẫn là các mục riêng, không tự gom hoặc tóm tắt.
- Không hiển thị lại bản reply tổng hợp nếu text đó đã có trong event SDK; reply fallback vẫn giữ khi provider chưa phát text tương ứng.

## Lưu và khôi phục

- Dùng `agent.activity` với `agent_role: system_engineer`, `sdk_event`, `activity_id`, `sdk_run_id`, `sdk_sequence`, `conversation_id`, `correlation_id`.
- Ghi qua Communication Store hiện có trước khi phát event đầy đủ lên SSE. Lỗi lưu được ghi log và trả lại luồng thực thi, không âm thầm hiển thị event chưa lưu.
- `activity_id` đi cùng cả SSE và lịch sử để chống trùng khi reconnect. `sdk_run_id` phân biệt item ID được SDK tái sử dụng giữa các lượt/continuation.
- API lịch sử chat chỉ bổ sung event đầy đủ của SE; event monitor thông thường của các role khác vẫn không chen vào transcript chat.
- Lịch sử tiếp tục phân trang; mỗi event không bị cắt nội dung. Transcript không được tự động đưa vào prompt/context gửi model.
- Các event cũ chỉ lưu summary không thể được nâng ngược thành output gốc.

## Bảo vệ dữ liệu

- Che credential đã biết, field nhạy cảm, Bearer token và các mẫu secret trong chuỗi; cùng chính sách được dùng khi stream và khi lưu/đọc lịch sử.
- Không đưa hidden reasoning/thinking, prompt của owner được SDK echo lại, hay thông tin khởi tạo nội bộ vào transcript.
- Token usage là số liệu vận hành, không phải credential; không che nhầm các bộ đếm này trong event SE.
- Event chỉ xuất hiện trong đúng project/conversation; tool output được React escape để ngăn HTML thực thi.

## Kiểm chứng

- Unit/integration test hẹp cho SDK callback SE, giới hạn role, output dài, array/field đầy đủ, secret/thinking, SSE schema, lưu trước phát, phân trang và lỗi lưu.
- Test hook SSE/history thực tế và JSX renderer: replay/reload không trùng, không gộp các tool chung correlation, output đa dòng và HTML escaping.
- Test restart SQLite/JSONL được bật trên runtime dự án Node >=22.5; runner Node cũ không có `node:sqlite` báo skip rõ ràng thay vì giả lập kết quả pass.
- Output đầy đủ làm tăng dung lượng conversation và chi phí render; đây là chủ đích theo yêu cầu, không tự bổ sung giới hạn cắt output.

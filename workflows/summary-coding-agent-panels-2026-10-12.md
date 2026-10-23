# Discussion Summary: /coding — header và panel agent

Đầu vào tạm thời cho `/plan`; không phải Architecture Plan, approval, Sprint Plan, ticket hay quyền triển khai.

## Goals

- Giữ header và Git Status nhìn thấy khi cuộn đúng vùng.
- Hiển thị riêng hành động của từng agent và giữ panel đến khi human đóng.
- Bố trí panel thành lưới trong Workspace Agent có cuộn dọc.

## In Scope

Các yêu cầu owner đã chốt, không phải mô tả hiện trạng code:

- Header `coding-workspace-monitor` ghim trong vùng cuộn của chính nó; Git Status phía phải.
- Sprint Plan và Workspace Agent có header riêng ghim trong từng cột, không ghim toàn trang.
- Mỗi agent thuộc Sprint Leader / Coder / Reviewer có một panel riêng. Tiêu đề gồm tên agent + role; nội dung chỉ hiển thị hành động của đúng agent đó.
- Agent chạy: chưa có panel thì tự mở; có rồi thì dùng lại, không tạo trùng.
- Agent idle: panel vẫn giữ, kể cả reload hoặc rời `/coding` rồi quay lại, đến khi human đóng.
- Lưới tối đa 3 cột theo chiều rộng Workspace Agent; vùng nhìn thấy tối đa 3 hàng theo chiều cao. Vượt 3 hàng thì cuộn dọc.

## Out of Scope

- Không tạo plan, sprint, ticket hoặc triển khai trong bước summary.
- Không bao gồm các chủ đề Home/navigation hay tự phân rã plan thành sprint trước đó.
- Đề xuất giữ nguyên hành vi chạy agent, trạng thái sprint và nguồn Git Status chưa được owner xác nhận là guardrail.

## Decisions

- Header ghim theo vùng/cột.
- Mỗi agent một panel; nhiều Coder có nhiều panel độc lập.
- Panel mở khi agent chạy, không mất khi idle, tồn tại qua reload/điều hướng cho đến khi human đóng.
- Tối đa 3 cột và 3 hàng nhìn thấy; phần vượt quá cuộn dọc.

## Assumptions / Repository Context

- Chưa khảo sát code `/coding`, định danh agent, nguồn sự kiện hay lưu/khôi phục panel; chưa chọn giải pháp kỹ thuật.
- Giảm còn 1–2 cột ở vùng hẹp là giả định cần xác nhận.
- Đã đọc `workflows/agents/architecture/README.md`: Architecture định hướng outcomes/guardrails; SL sở hữu phân rã delivery; plan không cấp quyền RUN.
- Đã đối chiếu `workflows/human-plan.md`, mục Chat Command Contract: `/summary` lưu Markdown tạm dưới `workflows/`, trả file identifier để dùng `/plan <id-file>`.

## Risks

- ID agent không ổn định có thể gây panel trùng hoặc trộn hành động.
- Tự mở lại ngay sau khi human đóng có thể vô hiệu hóa thao tác đóng.
- Khôi phục thiếu trạng thái có thể mất panel sau reload/điều hướng.
- Vùng cuộn lồng nhau và kích thước panel có thể gây header che nội dung hoặc không đạt 3 hàng nhìn thấy.

## Open Questions

- Human đóng panel khi agent đang chạy: có tự mở lại trong lượt hiện tại không?
- Lượt chạy mới có tự mở lại panel đã đóng không? Đề xuất chỉ mở lại ở lượt mới chưa được owner xác nhận.
- Lưu panel theo workspace, người dùng hay trình duyệt; có đồng bộ tab/thiết bị không?
- Ngoài sự hiện diện của panel, có cần giữ lịch sử hành động, thứ tự/vị trí và trạng thái cuộn không?
- Kích thước panel và quy tắc responsive khi thiếu chỗ cho 3 cột/3 hàng là gì?

## Acceptance Checks dự kiến

- Hai Coder chạy đồng thời có hai panel độc lập, không trộn hành động.
- `running → idle → running` dùng lại panel chưa đóng, không tạo trùng.
- Reload/điều hướng khôi phục panel chưa bị human đóng.
- Header ghim đúng vùng; vượt 3 hàng cuộn dọc.

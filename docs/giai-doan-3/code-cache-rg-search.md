<!-- Giải thích cách Codex rg_search phối hợp với Code Cache mà vẫn giữ ngữ nghĩa ripgrep. -->
# `rg_search` và Code Cache

Khi Code Cache được inject, `rg_search` dùng `rg --files` để chọn đường dẫn theo ignore, type và glob. Tool lấy nội dung từng file qua shared Code Cache/File Service rồi đưa nội dung vào ripgrep qua stdin để xử lý pattern và các flag tìm kiếm. Kết quả vẫn có đường dẫn, số dòng và exit code theo contract `rg_search`. Không có đường đọc nội dung trực tiếp từ filesystem bằng ripgrep trong nhánh này.

`sed_lines` dùng cùng cache cho lượt đọc mã tiếp theo. File bị bảo vệ, biến mất hoặc vượt giới hạn File Service được bỏ qua và ghi log metadata. Cache có thể giữ nội dung cũ trước khi watcher gửi event; watcher sẽ refresh hoặc invalidate theo checksum. `rg_files` vẫn chỉ liệt kê đường dẫn. Khi không inject cache, `rg_search` tiếp tục chạy ripgrep trực tiếp cho các harness cũ.

Test `backend/tests/tools/rg-search.test.js` kiểm tra kết quả tìm kiếm và chứng minh lượt tìm thứ hai cùng `sed_lines` không gọi lại File Service. Test watcher hai process kiểm tra refresh, checksum sai, cô lập project, rename và delete.

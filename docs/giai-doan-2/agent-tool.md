 Kế hoạch cập nhật:

  1. Tool adapter
      - Tạo backend/src/tools/read-transcript-blocks.js.
      - Inject cả:
          - protocolStorage: đọc request/response transcript theo ref.
          - fileService: đọc nội dung file được transcript tham chiếu.

      - Tool chỉ gọi fileService.readFile(...) cho path đã được Node cấp trong context/plan.

  2. Phân quyền path
      - Không nhận full_request_ref, full_response_ref hoặc filesystem path tùy ý từ agent.
      - Node map block_id/round → transcript refs và danh sách file được phép đọc.
      - File Service tiếp tục chịu trách nhiệm checksum, path traversal, ignored path và giới hạn
        project root.

  3. Kết quả tool
      - Trả về:
          - transcript metadata;
          - request/response đã resolve;
          - nội dung file qua Forge File Service;
          - exists, language, size_bytes, before_checksum.

      - Không trả file ngoài scope hoặc nội dung vượt giới hạn kích thước.

  4. Runtime
      - Thêm tool vào registry tại backend/src/tools/index.js.
      - Sender/Supervisor gọi tool service khi agent trả read_transcript_blocks.
      - Gửi tool result trở lại agent; chỉ submit_code_response mới kết thúc R3.

  5. Schema/prompt
      - Schema chỉ cho phép selector block_ids/rounds, file path nằm trong danh sách Node cấp.
      - Prompt ghi rõ: mọi file phải đọc qua Forge File Service, không đoán path/ref, không dùng
        filesystem trực tiếp.

  6. Test
      - Mock protocolStorage và Forge fileService.
      - Kiểm tra tool không thể đọc path ngoài scope, path traversal, file ignored hoặc task khác.
      - Kiểm tra luồng read_transcript_blocks -> File Service -> tool result ->
        submit_code_response.

  Em chưa sửa code ở bước này; chờ anh duyệt kế hoạch này rồi em mới triển khai.
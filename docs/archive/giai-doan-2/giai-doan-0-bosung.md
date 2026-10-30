Có. docs/giai-doan-2/giai-doan-0.md đang cũ và chưa phản ánh đúng code hiện tại.

  Các phần đã triển khai nhưng tài liệu vẫn ghi “Chưa làm”:

  - 0a-1b: schemas/agent/envelope.schema.json đã tồn tại.
  - 0a-4a/4b: đã có payload-schema-registry.js và envelope-validator.js.
  - 0a-4c: đã có backend/tests/unit/envelope-validator.test.js.
  - 0b-2: protocol-storage.js đã có save/get, checksum, metadata, chống traversal, atomic create.
  - 0c-2..0c-5: git-service.js đã có branch, commit, merge, discard.
  - 0d: ticket-status-store.js, ticket-status.js và integration tests đã tồn tại.
  - Phần adapter OpenAI 0e-1..0e-4, 0e-6, 0e-7 đã triển khai.

  Các phần còn thiếu hoặc cần xác nhận:

  1. 0a-1a/1c
      - Chưa có checklist/test riêng xác nhận toàn bộ enum envelope.
      - Envelope hiện có thêm code_response và submit_code_response, cần chốt đây là chủ ý hay enum cũ.

  2. 0a-5
      - Có request-anthropic.schema.json và response-anthropic.schema.json, nhưng cần xác nhận chúng đã đầy đủ
        biến thể Anthropic cuối cùng (system_blocks, cache semantics, delivery, in_window) chưa.

      - Tài liệu vẫn mô tả phần này chưa làm.

  3. 0b-3
      - protocol-storage.js hiện chưa export hàm list(task_id).
      - Đây là thiếu thật so với tài liệu và ảnh hưởng khả năng liệt kê transcript/report.

  4. 0c-1
      - Đã dùng Git CLI thay vì simple-git. Đây là lựa chọn hợp lệ, nhưng tài liệu chưa ghi quyết định thực tế.

  5. 0d
      - Tài liệu dùng trạng thái cũ in_progress/coder_completed/merge_conflict.
      - Code hiện dùng thiết kế mới với pending, blocked, running, reviewing, done, failed, cancelled,
        needs_human_review.

      - Cần cập nhật tài liệu để tránh hiểu sai API.

  6. 0e
      - Tài liệu ghi “Adapter Claude”, trong khi code hiện đã triển khai pipeline OpenAI.
      - 0e-5 gọi provider thật vẫn chưa được smoke-test với credential/API thật.
      - Claude adapter tương đương chưa hoàn tất.

  7. Thứ tự phụ thuộc trong tài liệu đã lỗi thời:
      - Tài liệu nói 0e-1 cần 0b-2, nhưng OpenAI resolver hiện đã dùng Protocol Storage đúng hướng.
      - Cần tách rõ “OpenAI pipeline đã có” và “Claude pipeline còn thiếu”.

  Kết luận: Giai đoạn 0 chưa thể đánh dấu hoàn tất tuyệt đối. Thiếu thực tế rõ nhất là 0b-3 list(task_id),
  provider smoke test 0e-5, và phần Claude; còn lại chủ yếu là tài liệu chưa cập nhật theo implementation mới.
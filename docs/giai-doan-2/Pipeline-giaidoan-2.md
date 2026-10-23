Pipeline tổng thể nên chia thành 2 lớp:

  Sơ đồ B: Orchestrator ngoài
    Ticket → Guard → Agent profile → Branch → Inner loop A
    → Verify → Commit/Merge → Report/Notify

  Sơ đồ A: Vòng giao tiếp Node ↔ Agent
    task → code_needed → code_provide → submit_code_response
    → usage_query → usage_needed/no_wiring_needed
    → code_provide → submit_code_response
    → status_check → completed/continue

  Pipeline đầy đủ:

  1. Nhận ticket
     - Node đọc ticket JSON.
     - Xác định project, sprint, agent_role và acceptance criteria thuộc role đó.
     - Sinh envelope:
       request_id, parent_id=null, type=task, role=node, timestamp.

  2. Guard đầu vào
     - Kiểm tra ticket/dependencies/path policy.
     - Tạo task/session và lưu request vào Protocol Storage.
     - Chọn Agent Profile để biết provider/model.

  3. Chuẩn bị môi trường
     - Tạo branch riêng `task/<ticket_id>`.
     - Xác định Code Index hiện tại.
     - Gửi task request cho Agent qua adapter OpenAI hoặc Anthropic.

  4. Agent yêu cầu code tham khảo
     - Agent trả envelope `type=code_needed`, `role=agent`.
     - Payload gồm file/query và lý do.
     - Node validate envelope + payload bằng discriminator.
     - Node không cho Agent tự đoán file.

  5. Node cung cấp code
     - Node tra Code Index trước.
     - Nếu file tồn tại: đọc nội dung thật, line range/checksum.
     - Nếu file không tồn tại: báo rõ file chưa tồn tại, yêu cầu Agent tạo file theo convention.
     - Lưu response vào Protocol Storage.
     - Gửi `type=code_provide`, `role=node`.

  6. Agent trả code
     - Agent phải trả `type=submit_code_response`; `code_response` chỉ được chấp nhận tạm thời như alias tương thích.
     - Payload phải đúng `full_content`, `unified_diff` hoặc `apply_patch` theo format Node chỉ định.
     - Node validate schema trước khi ghi file.
     - Kiểm tra path guard và format parser.
     - Patch/tạo file trên branch.
     - Re-index file sau khi ghi.

  7. Kiểm tra cách sử dụng code
     - Node gửi `type=usage_query`.
     - Node kiểm tra dependency graph/index trước.
     - Nếu đã được import/sử dụng: Agent trả `no_wiring_needed`.
     - Nếu chưa: Agent trả `usage_needed` và yêu cầu file/component liên quan.

  8. Đấu nối
     - Node lại tra Index, đọc toàn bộ file cần thiết.
     - Gửi `type=code_provide` lần hai.
     - Agent trả code wiring theo cùng format.
     - Node validate, patch, re-index.
     - Lặp lại bước 7–8 nếu dependency graph còn thiếu.

  9. Kiểm tra hoàn tất
     - Node gửi `type=status_check`.
     - Chỉ gửi acceptance criteria thuộc role của Agent.
     - Agent trả:
       - `completed` nếu đã xong;
       - `continue` nếu còn việc.
     - Nếu `continue`, quay lại bước 4 hoặc 7 tùy loại việc còn thiếu.

  10. Kết thúc outer orchestration
      - Node chạy lint/typecheck/build/test theo ticket.
      - Nếu fail: ghi lỗi, có thể mở vòng retry mới với `parent_id` trỏ message lỗi.
      - Nếu pass: commit branch.
      - Verify/Reviewer tùy pipeline.
      - Merge hoặc giữ branch theo policy.
      - Ghi report và phát notification cho owner.

  Quan hệ giữa hai sơ đồ:

                  ┌──────────────────────────────┐
                  │ Sơ đồ B: Orchestrator ngoài  │
                  │ ticket / guard / git / verify│
                  └──────────────┬───────────────┘
                                 │
                                 ▼
          ┌─────────────────────────────────────────────┐
          │ Sơ đồ A: Inner Node ↔ Agent loop             │
          │ task → code_needed → code_provide           │
          │ → code_response → usage → wiring → status   │
          └──────────────┬──────────────────────────────┘
                         │
               completed │ continue / retry
                         ▼
                  Verify → Commit → Report

  Các thành phần hỗ trợ xuyên suốt:

  Envelope
    -> trace request_id/parent_id/type/role

  Canonical request.schema.json
    -> dữ liệu chung của Node

  Provider request schema
    -> OAI hoặc Anthropic projection

  Payload registry + validator
    -> chọn schema theo role:type

  Code Index
    -> tìm file/symbol/import trước khi cung cấp context

  Protocol Storage
    -> lưu full request/response theo ref

  Git/Verification layer
    -> branch, patch, test, commit, merge

  Điểm mấu chốt là Agent không trực tiếp đọc filesystem và không tự quyết định cấu trúc project. Agent chỉ yêu
  cầu context; Node dùng Index và filesystem để cung cấp dữ liệu thật. Còn Sơ đồ B chịu trách nhiệm vòng đời
  ticket, Git, verify và báo cáo.
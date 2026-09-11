Quy trình hoàn thành một tool trong Forge gồm 8 bước:

  1. Thiết kế contract
      - Xác định tên tool, input, output, lỗi và quyền.
      - Ví dụ: read_transcript_blocks.

  2. Tạo schema
      - Schema input bắt buộc field, kiểu dữ liệu, giới hạn và additionalProperties: false.
      - Schema output/tool-result.
      - Đăng ký vào payload-schema-registry.

  3. Định nghĩa provider
      - Thêm tool vào OpenAI schema.
      - Thêm tool vào Anthropic schema.
      - Thêm mapping trong response normalizer để biến tool call thành envelope chuẩn:

        {
          type: "read_transcript_blocks",
          payload: { ... }
        }

  4. Viết implementation
      - Tạo module trong backend/src/tools.
      - Tool không tự truy cập filesystem.
      - Với transcript tool:
          - đọc transcript qua Protocol Storage;
          - đọc file qua Forge File Service.

  5. Thêm phân quyền
      - Node cấp capability:

        capabilities: ["read_transcript_blocks"]

      - Kiểm tra task_id, block scope, file scope.
      - Sai quyền trả TOOL_FORBIDDEN.

  6. Đăng ký runtime
      - Đưa tool vào registry.
      - Inject registry vào Supervisor/round controller.
      - Nếu thiếu dependency thì báo lỗi cấu hình rõ ràng.

  7. Xử lý vòng đời gọi tool

     Agent tool call
     -> normalize envelope
     -> validate schema
     -> authorize
     -> execute tool
     -> tạo tool_result
     -> gửi lại cho Agent
     -> Agent trả action tiếp theo

     Tool trung gian không được kết thúc task. Với R3, chỉ submit_code_response mới chuyển sang
     materialize.

  8. Test
      - Schema hợp lệ/không hợp lệ.
      - Capability và task scope.
      - Path traversal/file ngoài plan.
      - Provider normalization.
      - Luồng end-to-end tool call -> tool_result -> final response.

  Đối với read_transcript_blocks, quy trình hiện tại đã có các phần từ schema, implementation,
  permission, provider, registry đến Supervisor dispatch; phần cần tiếp tục hoàn thiện là test end-
  to-end đầy đủ.

  Quy trình code độc lập cho mỗi tool nên là:

  1. Chốt contract
      - Tên tool.
      - Input/output.
      - Error codes.
      - Capability và phạm vi truy cập.

  2. Tạo schema trước
      - schemas/agent/tools/<tool>.schema.json
      - Schema result nếu cần.
      - additionalProperties: false.
      - Validate bằng Ajv.

  3. Viết implementation độc lập
      - backend/src/tools/<tool>.js
      - Nhận dependency qua injection.
      - Không import Supervisor hoặc pipeline.
      - Không tự dùng fs nếu phải đi qua Forge service.

  4. Viết authorization
      - Kiểm tra capability.
      - Kiểm tra task_id/conversation scope.
      - Kiểm tra resource/path được Node cấp.

  5. Tạo registry Lab
      - backend/src/tools/index.js
      - Registry chỉ phục vụ test độc lập.
      - Chưa đăng ký vào Stage-1/Supervisor.

  6. Tạo harness test agent thật
      - backend/scripts/test-<tool>.mjs
      - Tạo fixture storage/file.
      - Gọi Agent Gateway trực tiếp.
      - Cung cấp đúng một tool.
      - Nhận tool call, execute bằng registry, gửi tool_result lại agent.

  7. Test contract/security
      - Input hợp lệ/sai schema.
      - Thiếu quyền.
      - Sai task.
      - Resource ngoài scope.
      - Dependency bị thiếu.
      - Kết quả đúng schema.

  8. Đánh dấu tool hoàn tất
      - Schema pass.
      - Unit test pass.
      - Agent thật gọi được.
      - Security test pass.
      - Không làm thay đổi pipeline hiện tại.

  9. Tích hợp sau cùng
      - Khi tất cả tool hoàn tất mới thêm adapter vào:

        Supervisor -> Sender -> Tool Registry -> Agent

      - Khi đó mới sửa provider tool list, round controller và lifecycle production.

  10. Governance chung cho Tool Lab
      - Context mặc định chỉ chứa reference/summary; full content chỉ được lấy bằng retrieval
        on-demand.
      - Mọi retrieval phải đi qua Node-provided exact scope và Context Budget. Tool Lab dùng
        `backend/src/tools/retrieval-governance.js` để kiểm tra `execution_scope`,
        `context_budget`/`retrieval_budget`, quota số lần gọi và audit callback.
      - `read_code` chỉ đọc một exact file hoặc exact symbol tuple; `read_transcript_blocks` chỉ
        đọc file/block được duyệt; `search_code` chỉ trả metadata; `select_code_graph_candidates`
        không đọc nội dung.
      - Runtime vẫn giữ identity, permission, lifecycle, persistence, queue, event và atomic
        apply. Các tool không tự dump repository, không tự suy luận thay Agent và chưa tự động
        mở rộng vào production pipeline.

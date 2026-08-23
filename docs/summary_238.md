Tổng kết cuộc trao đổi — Forge Node ↔ Agent Architecture
1. Nền tảng khái niệm
Agent (Claude/ChatGPT API) stateless — không tự nhớ gì giữa các lần gọi. Mọi "trí nhớ" (session, context, lịch sử) đều do Node tự quản lý và tái gửi mỗi lần.
Không có session/socket thật giữ mở giữa Node và Agent — "liên lạc" chỉ là request/response HTTPS độc lập từng lần, Node tạo cảm giác liên tục bằng cách tự lưu + tái tạo context.
2. Schema Request/Response Node ↔ Agent (Builder)
FORGE-SCHEMA-014 (Claude) và FORGE-SCHEMA-014-OAI (ChatGPT) — 2 file song song, cùng logic, khác cách nhúng cache theo từng provider (cache_control vs prompt_cache_breakpoint/prompt_cache_key).
Đã bổ sung conversation_mode (full_transcript / rolling_summary / hybrid) — cách Node quản lý lịch sử hội thoại nhiều round, cả 2 file đã đồng bộ lên v1.4/v1.4-oai.
Diff/patch: bàn nhiều dạng (unified diff, search/replace block, full file, structured patch) — khuyến nghị search/replace block làm mặc định vì an toàn/tiết kiệm nhất, Node cần dry-run + checksum + backup trước khi ghi thật.
3. Execution Layer (nội bộ Node, sau khi nhận response)
FORGE-EXEC-001: spec đầy đủ các hàm — Dispatch, Handler theo loại diff, Pre-write Guard, Write Layer, Post-write Verify, Retry Logic, State/Logging.
FORGE-EXEC-002: chuẩn hóa hợp đồng nội bộ ExecutionResult + ExecutionContext + enum error_code cố định (9 mã: CHECKSUM_MISMATCH, PATCH_NOT_APPLICABLE, AMBIGUOUS_MATCH, NO_MATCH, SYNTAX_ERROR, LINT_FAILED, TEST_FAILED, BUILD_FAILED, IO_ERROR).
→ Bạn xác nhận: đã implement thật trong src/application/execution-layer.js, khớp đúng thiết kế, test pass.
4. Reviewer Agent (Quality Layer)
Vai trò: kiểm tra code Builder sinh ra, chạy sau test (tận dụng kết quả test làm dữ liệu, tiết kiệm 1 lượt AI nếu test đã fail rõ).
review_context cần phân cấp: Minimal / Structural / Contextual — tùy review_criteria bật gì, tránh gửi thừa toàn bộ project.
Giới hạn tối đa ~3 vòng Builder↔Reviewer trước khi escalate lên user.
5. Test coverage
Builder cần được giao trách nhiệm sinh test (include_tests) hoặc tách Test Writer Agent riêng cho task rủi ro cao (tránh self-review bias).
Xác định test liên quan (test_scope): kết hợp naming convention + dependency graph + coverage map — không chạy full suite mỗi lần.
6. Project Map (Shared Infra)
Đề xuất Node xây và duy trì 1 "bản đồ dự án" (imports/imported_by/test_files/module_role) làm nguồn dữ liệu dùng chung cho Reviewer context lẫn Test scope, cập nhật incremental sau mỗi commit thay vì tính lại mỗi lần.
7. Đơn giản hóa giao tiếp Node↔Agent
Đề xuất gom logic build/gửi request thành 2 hàm dùng chung: buildAgentTicket (lắp request từ taskState) và dispatchAgentTicket (gọi API + chuẩn hóa response bất kể provider) — tránh lặp logic ở mọi nơi cần gọi Agent.
8. Sprint Planning — làm phẳng về mức Ticket
Xác nhận nguyên tắc: Forge chỉ nhận ticket, không nhận "phase" — phase chỉ là nhãn phân nhóm hiển thị, không phải đơn vị giao việc.
Đã làm phẳng toàn bộ 4 phase (Foundation/Execution/Quality/Shared Infra) thành danh sách ticket cụ thể, có cột "Input cần có trước" thay cho dependency theo phase.
9. Rà soát thực trạng — quyết định KHÔNG rollback
Bạn cung cấp trạng thái thực tế: Gateway, Schema (49 schema/72 fixture), Execution Layer skeleton, Watcher/Indexer/Verification đã chạy, test pass.
Kết luận: không nên rollback về mốc UI sprint — phần "lộn xộn" thực chất là khoảng trống cụ thể (chưa wire handler thật vào Execution contract, dọn git/thư mục cũ, thiếu smoke test E2E), không phải lỗi kiến trúc cần viết lại.
Đề xuất 3 ticket bổ sung: FORGE-EXEC-001a (wire handler thật), FORGE-OPS-001 (dọn vệ sinh), FORGE-QA-001 (smoke test E2E).
10. Sprint Leader Agent (đang thiết kế dở)
Ý tưởng: 1 Agent riêng nhận mô tả sprint tự nhiên từ UI, tự sinh danh sách ticket đã làm phẳng (không trả về ở mức phase).
Đã phác schema Request/Response (FORGE-SPRINT-001), validate layer chống circular dependency/trùng ticket_id (FORGE-SPRINT-002), và tích hợp UI tận dụng Agent Gateway + SSE + Sprint dashboard đã có sẵn (FORGE-SPRINT-003) — chưa xuất thành file, mới dừng ở thảo luận.

File đã lưu trong outputs: FORGE-SCHEMA-014.md, FORGE-SCHEMA-014-OAI.md, FORGE-EXEC-001.md, FORGE-EXEC-002.md.

Việc còn treo, chưa thành ticket file: FORGE-SCHEMA-015 (Reviewer), FORGE-TEST-001/002 (Test), FORGE-INFRA-001 (Project Map), FORGE-CORE-001 (buildAgentTicket/dispatchAgentTicket), FORGE-SPRINT-001/002/003 (Sprint Leader Agent), FORGE-EXEC-001a/FORGE-OPS-001/FORGE-QA-001 (khoảng trống thực tế vừa phát hiện).

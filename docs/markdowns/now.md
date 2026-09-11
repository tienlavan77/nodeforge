Đã hoàn thành và đang được nối

  - Node Control API:
      - HTTP API tại port 3100.
      - Agent Gateway hỗ trợ Claude/DevQuote và OpenAI Responses API.
      - Owner chat gửi đúng agent, lưu communication/history và stream SSE.
      - Builder có agent tool loop: request_info → context → submit_code.
      - Context builder đọc project/index trước khi gửi Builder.

  - Agent/UI:
      - UI có các tab Architecture Manager, Sprint Leader, Builder, Reviewer.
      - Chat stream qua SSE, có batching/progress/token usage.
      - Sprint dashboard có Run, trạng thái running, xử lý 409, hiển thị stream.
      - Vite đã proxy tới VPS qua:

        VITE_NODE_API_URL=http://192.168.1.181:3100

  - File/DB pipeline:
      - Agent ghi file qua FileService, có project-root guard, secret/path protection và queue.
      - Watcher dùng polling, quan sát project mount.
      - Indexer ghi source index vào:

        .forge/runtime/wc/index.db

      - Control API/chat/events ghi vào:

        .forge/runtime/nf/index.db

      - DatabaseService được dùng cho queued SQLite writes.
      - Watcher bỏ qua .forge/** và .node-control/** để tránh feedback loop.
      - Watcher log:

        Filesystem change
        Watcher event
        Indexer updated

  - Verification:
      - Check chạy tuần tự trước test.
      - Có timeout theo loại check.
      - Watcher → indexer → verification pipeline đã có.
      - verification.result được persist/event stream.

  Schema hiện có

  - Tổng cộng 49 schemas, 72 fixtures.
  - Đã có:
      - Agent tool schema.
      - Agent request/response v1.4.
      - Claude cache context.
      - OpenAI Responses v1.4-OAI:
          - conversation_mode
          - transcript_blocks
          - prompt_cache_key
          - prompt_cache_breakpoint

      - Execution schema:
          - execution-result.schema.json
          - execution-context.schema.json

  Execution Layer mới thêm

  Đã tạo:

  src/application/execution-layer.js

  Có:

  - createExecutionResult
  - createExecutionContext
  - withExecutionResult
  - evaluateApplyResult
  - logExecutionTrace

  Các error code đã chuẩn hóa:

  CHECKSUM_MISMATCH
  PATCH_NOT_APPLICABLE
  AMBIGUOUS_MATCH
  NO_MATCH
  SYNTAX_ERROR
  LINT_FAILED
  TEST_FAILED
  BUILD_FAILED
  IO_ERROR

  Kiểm thử hiện tại

  Đã chạy đạt:

  npm run validate:schemas
  npm run lint
  npm run typecheck
  npm run build:web
  git diff --check

  Các test watcher, database service, file service, agent gateway, transcript và execution layer
  đều pass.

  Phần còn thiếu/rủi ro

  - Execution contract mới chưa được tích hợp vào các handler thực tế như applyUnifiedDiff,
    applySearchReplaceBlock, backupFile, rollbackFile; hiện codebase chưa có các handler này
    thành module riêng.

  - Watcher và Control API phải chạy trên VPS; PID trên macOS không phản ánh process VPS dù
    filesystem được mount.

  - Cần dọn/kiểm tra thư mục .node-control cũ để tránh nhầm database legacy.
  - Worktree đang có nhiều thay đổi chưa commit và nhiều file sprint/untracked.
  - Chưa có một smoke test end-to-end duy nhất chứng minh trọn chuỗi:

    UI chat/Run
    → gateway
    → FileService
    → watcher
    → wc/index.db
    → verification
    → history/SSE

  Nói ngắn gọn: nền tảng Node–Agent–UI–Watcher–Indexer–Verification đã nối được; phần đang ở mức
  “contract mới tạo nhưng chưa refactor toàn bộ execution handlers” là khoảng trống lớn nhất hiện
  tại.
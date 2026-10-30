<!-- Tổng hợp thảo luận và định hướng kế hoạch kiến trúc cho quy ước comment chi tiết thuần ngôn ngữ và ngân sách 250 dòng không tính comment/dòng trống. -->
# Plan: Chuẩn hóa quy ước Comment chi tiết thuần ngôn ngữ và Ngân sách 250 dòng (loại trừ Comment & dòng trống)

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:**
  - Bộ đếm giới hạn 250 dòng trong `write_diff` (`backend/src/tools/agent-lifecycle-tools.js`, `sha256:90bb9af5a6ca913475e2c1b8ea5149bce99952bf6ae05e6c8be98572b0664b8f`) hiện đang đếm dòng vật lý (`content.split("\n").length`), còn `edit_diff` chưa chặn khi bản sửa đẩy file đang hợp lệ vượt quá 250 dòng. Điều này khiến Coder ngại viết comment giải thích chi tiết hoặc chia dòng thoáng vì sợ chạm trần 250 dòng (`CONTENT_TOO_LARGE` / `DESTRUCTIVE_OVERWRITE`).
  - Quy tắc comment trong `backend/src/tools/agent-code-conventions.js` (`sha256:b87c82b338835852f8c74cc8fa5523b4214b86a92de92aa1dcba0d4515880bd2`), prompt (`backend/src/modules/supervisor/nodeforge-task-prompts.js`, `sha256:0d95865d6a4c561932fb4b12bb85ee34469a60bc5bc6e139944cc4faaf2c91a4`), và tài liệu (`CLAUDE.md`, `AGENTS.md`, `workflows/agents/coder/README.md`, `workflows/agents/reviewer/README.md`) đang yêu cầu viết *"short summary comment"*, ép cứng ngôn ngữ theo code/tiếng Anh, và `hasPrecedingComment` chỉ kiểm tra dòng liền trước bắt đầu bằng `/^(?:\/\/|\/\*|#|<!--)/` (sẽ báo lỗi sai khi dùng JSDoc/block comment nhiều dòng kết thúc bằng `*/`).
  - Bộ thu thập comment của Indexer (`backend/src/modules/index/index-record-writer.js`, `sha256:ecb3655b357cd719f896959dc1fdba6346aa61ff5a90abcb51f5ef2b3d0bf700`) chỉ quét ngược tối đa 3 dòng phía trên symbol (`start - 2` đến `start - 4`), làm mất phần lớn nội dung khi Coder viết comment chi tiết nhiều dòng để phục vụ Full-Text Search (`symbol_content_fts`) và Vector Embedding (`symbol_embeddings`).
- **Kết quả:**
  - Ngân sách 250 dòng của mọi loại file được tính theo **số dòng thực chất (`code_lines` / `budget_lines` — loại trừ toàn bộ dòng trống và dòng chỉ chứa comment)** khi kiểm tra qua `write_diff` và `edit_diff`, hiển thị qua `read_file` (cùng `read_lines` / `sed_lines` nếu có `total_lines`), và khi Reviewer nghiệm thu.
  - Coder được yêu cầu viết **comment chi tiết** (nêu đầy đủ mục đích nghiệp vụ và mô tả kỹ thuật) cho file mới và symbol/function mới; linh hoạt sử dụng **Tiếng Anh hoặc Tiếng Việt**, nhưng phải **thuần nhất một ngôn ngữ và đảm bảo ngữ nghĩa** (không trộn lẫn cấu trúc câu Anh – Việt tùy tiện ngoài tên định danh kỹ thuật/symbol).
  - Indexer thu thập trọn vẹn toàn bộ khối comment chi tiết phía trên mỗi symbol (có chặn biên dưới để không lấy nhầm file header comment hoặc symbol trước đó) để đưa vào `symbol_content_fts` và `symbol_embeddings`.
- **Giá trị:** Tăng chất lượng ngữ nghĩa của kho chỉ mục tìm kiếm (`select_code_graph_candidates` / hybrid search & vector embedding) mà không làm thu hẹp không gian viết code thực tế trong ngưỡng 250 dòng của Agent.

## 2. Phạm vi

### In scope

- Xây dựng bộ phân tích dòng và đếm dòng ngân sách (`countBudgetLines` / `stripCommentsFromLine`) trong `backend/src/tools/agent-code-conventions.js`:
  - Xử lý chính xác dòng hỗn hợp (vừa có code vừa có `/* ... */`, `<!-- ... -->`, hoặc `//`) và phân biệt `#` comment/shebang với ES2022 private class fields/methods (`#field`).
- Nâng cấp trích xuất và kiểm tra comment đầu file / trước function trong `backend/src/tools/agent-code-conventions.js` (`extractPrecedingCommentBlock`, `hasFileHeaderComment`, `hasPrecedingComment`, `validateCommentLanguage`):
  - Hỗ trợ đầy đủ khối comment nhiều dòng (`//`, `#`, JSDoc/block `/* ... */` kết thúc bằng `*/`, `<!-- ... -->`).
  - Kiểm tra tính thuần nhất ngôn ngữ (Tiếng Anh hoặc Tiếng Việt): làm sạch token kỹ thuật (backticks, quotes, URL, path, JSDoc tags, `camelCase`, `PascalCase`, `snake_case`, `UPPER_SNAKE_CASE`, `fn()`) trước khi phát hiện lỗi trộn từ vựng Tiếng Việt có dấu với hư từ/động từ chia ngôi cấu trúc câu Tiếng Anh.
- Cập nhật `backend/src/tools/agent-lifecycle-tools.js` (và đồng bộ hiển thị `code_lines` trên `committed-review-window.js` / `sed-lines.js` khi trả về `total_lines`):
  - `read_file`: Giữ `total_lines` (dòng vật lý phục vụ `offset`/`limit` và `read_lines`) và bổ sung `code_lines` (số dòng ngân sách không tính comment và dòng trống).
  - `write_diff` & `edit_diff`: Áp dụng `countBudgetLines` cho ngưỡng 250 dòng (`CONTENT_TOO_LARGE` và `DESTRUCTIVE_OVERWRITE`, giữ `line_count`/`current_lines` kèm `code_lines` và `total_lines` trong `error.details` để tương thích unit test hiện hữu). Với `edit_diff`, chặn `CONTENT_TOO_LARGE` nếu file trước khi sửa ≤ 250 `code_lines` nhưng sau khi sửa > 250 `code_lines`.
  - Cập nhật thông báo `SUMMARY_REQUIRED` và `buildConventionReminder` theo quy tắc comment chi tiết thuần ngôn ngữ (EN hoặc VI).
- Mở rộng bộ quét comment phía trên symbol trong `backend/src/modules/index/index-record-writer.js` (`indexContent`) để lấy toàn bộ khối comment liên tiếp (không giới hạn 3 dòng), đồng thời chặn biên dưới theo `prevSymbolEndLine` và dừng khi gặp dòng code hoặc quá 1 dòng trống sát symbol.
- Đồng bộ hóa hướng dẫn trong `backend/src/modules/supervisor/nodeforge-task-prompts.js`, `CLAUDE.md`, `AGENTS.md`, `workflows/agents/coder/README.md`, và `workflows/agents/reviewer/README.md`.

### Out of scope

- Không thay đổi giới hạn 80 dòng vật lý của cửa sổ đọc source trong `read_file` / `read_lines` (vì đây là giới hạn hiển thị context window và line-number indexing).
- Không thay đổi cấu trúc bảng SQLite của `symbol_content_fts`, `symbol_embeddings`, hoặc model embedding hiện hành (`text-embedding-3-small`).
- Không bắt buộc viết lại comment cho toàn bộ các file/function cũ trong repository khi không có thay đổi liên quan.

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc bắt buộc:**
  - Giữ nguyên `total_lines` trong kết quả trả về của `read_file` là tổng số dòng vật lý để không làm hỏng cơ chế định vị dòng (`offset`, `limit`, `start_line`, `end_line`) của các công cụ đọc/sửa file.
  - Giữ nguyên tên trường `line_count` và `current_lines` (bên cạnh `code_lines` và `total_lines`) trong `error.details` của `write_diff` để tương thích 100% với các unit test hiện hữu (`agent-lifecycle-tools-v2.test.js`).
  - Quy tắc ngân sách ≤ 250 `code_lines` (loại trừ comment và dòng trống) áp dụng thống nhất cho mọi file đi qua `write_diff` và `edit_diff`.
  - Quy tắc ngôn ngữ comment: Cho phép Tiếng Anh hoặc Tiếng Việt có dấu đầy đủ ngữ nghĩa, nhưng nghiêm cấm trộn lẫn từ vựng Tiếng Việt có dấu với hư từ/động từ cấu trúc câu Tiếng Anh trong cùng một khối comment (ngoại trừ tên biến, tên hàm, mã lỗi, thẻ JSDoc, đường dẫn, hoặc thuật ngữ kỹ thuật chuẩn).
- **Hướng đề xuất:**
  - Trong `agent-code-conventions.js`: Thiết kế `stripCommentsFromLine(line, state)` theo dõi `state.inBlockComment` (`"/*"` hoặc `"<!--"`): sau khi bóc tách comment khối và inline comment (`//`, `#!` hoặc `/^#\s/`, tránh cắt nhầm `://` hoặc `#privateField` của JS/TS), nếu phần còn lại có `trim().length > 0` thì tính là 1 `code_lines`. Dùng chung `extractPrecedingCommentBlock` cho cả kiểm tra sự tồn tại và kiểm tra ngôn ngữ.
  - Trong `index-record-writer.js`: Duyệt `rows` (đã sắp theo `start_line`), theo dõi `prevSymbolEndLine` làm biên chặn dưới; quét ngược từ `start - 2` lên tới `minLine`, chỉ bỏ qua `@decorator` hoặc tối đa 1 dòng trống sát symbol và thu thập trọn vẹn khối comment liên tiếp để ghép vào `snippet` (giữ trần 4000 ký tự).
- **Dependency thật sự:**
  - Các hàm helper đếm dòng ngân sách, trích xuất khối comment và kiểm tra ngôn ngữ trong `agent-code-conventions.js` (`O1`, `O2`) phải hoàn tất trước hoặc cùng lúc với việc tích hợp vào `agent-lifecycle-tools.js`.
- **Quyết định chưa chốt:** Không có (Owner đã xác nhận đầy đủ yêu cầu và SE đã đóng góp phản hồi kỹ thuật chi tiết trong `workflows/plan-comment-language-and-line-budget-feedback.md`).

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `backend/src/tools/agent-code-conventions.js` | Kiểm tra header/function comment đa dòng, đếm `code_lines` (`countBudgetLines`) và kiểm tra thuần ngôn ngữ (`validateCommentLanguage`) | `sha256:b87c82b338835852f8c74cc8fa5523b4214b86a92de92aa1dcba0d4515880bd2` (dòng 1–26) |
| `backend/src/tools/agent-lifecycle-tools.js` | Thực thi `read_file` (`code_lines`), `write_diff` & `edit_diff` (gate 250 `code_lines`), và kiểm tra `SUMMARY_REQUIRED` | `sha256:90bb9af5a6ca913475e2c1b8ea5149bce99952bf6ae05e6c8be98572b0664b8f` (dòng 14, 54, 95–156, 173–210) |
| `backend/src/modules/supervisor/committed-review-window.js` & `backend/src/tools/sed-lines.js` | Đồng bộ trả thêm `code_lines` bên cạnh `total_lines` khi đọc cửa sổ dòng cho Reviewer/Coder | `sha256:bad53cbf97efd5248cccc52b2278a6cd88bbe78f06ffba6daccaf59467f72cfb`, `sha256:b2be409db62e242a376f94dcbb78f14d2f1f9c21e70080852a7dfab01f3f1024` |
| `backend/src/modules/index/index-record-writer.js` | Thu thập trọn vẹn khối comment phía trên symbol (có chặn biên `prevSymbolEndLine`) khi đánh chỉ mục FTS và embedding | `sha256:ecb3655b357cd719f896959dc1fdba6346aa61ff5a90abcb51f5ef2b3d0bf700` (dòng 37–75) |
| `backend/src/modules/supervisor/nodeforge-task-prompts.js` | Xây dựng system/ticket prompt cho Coder (quy ước ngôn ngữ, comment chi tiết, 250 dòng `code_lines`) | `sha256:0d95865d6a4c561932fb4b12bb85ee34469a60bc5bc6e139944cc4faaf2c91a4` (dòng 40, 80–86, 140) |
| `CLAUDE.md` & `AGENTS.md` | Tài liệu quy chuẩn cấp repository cho Agent | `sha256:de237b2bdf9308a0cc36610a017a2914f8f2bc68e53cd4b227c1eb0a5445c3c6` (dòng 1–35) |
| `workflows/agents/coder/README.md` & `workflows/agents/reviewer/README.md` | Rulebook của Coder Agent và Reviewer Agent | `sha256:4d82508c1121d5ac3109c7a49989c70f2f20e0e3cae4f0eccf7598cc9654e3e6`, `sha256:2c399fb5690204cfe4541b12bdb4472698f13c12d15ef5ad654a0d684ee97f12` |

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Chuẩn hóa bộ đếm dòng ngân sách (`code_lines` — loại trừ comment và dòng trống) và áp dụng vào công cụ đọc/ghi/sửa file | 1. `countBudgetLines(content)` loại trừ chính xác mọi dòng trống, dòng chỉ chứa comment đơn (`//`, `#!`, `/^#\s/`) và khối comment đa dòng (`/* ... */`, `<!-- ... -->`), đồng thời tính đúng dòng hỗn hợp có code + comment và giữ nguyên ES2022 `#privateField`.<br>2. `write_diff` và `edit_diff` cho phép ghi/sửa mọi loại file có tổng số dòng vật lý > 250 miễn là `code_lines` ≤ 250; chặn `CONTENT_TOO_LARGE` / `DESTRUCTIVE_OVERWRITE` khi `code_lines` > 250 (giữ `line_count` / `current_lines` và bổ sung `code_lines`, `total_lines` trong `error.details`).<br>3. `read_file` (và `read_lines` / `sed_lines` nếu trả `total_lines`) giữ nguyên `total_lines` (dòng vật lý) và trả thêm `code_lines`. | Giữ tương thích ngược cho `total_lines`, cửa sổ đọc 80 dòng và các unit test trong `agent-lifecycle-tools-v2.test.js`. |
| O2 | Nâng cấp kiểm tra quy ước Comment chi tiết đa dòng và tính thuần nhất ngôn ngữ (Tiếng Anh hoặc Tiếng Việt) | 1. `hasFileHeaderComment` và `hasPrecedingComment` (qua `extractPrecedingCommentBlock`) nhận diện đúng cả khối comment nhiều dòng (`//`, `#` liên tiếp hoặc JSDoc/block `/* ... */` kết thúc bằng `*/`, `<!-- ... -->` ngay phía trên hàm/đầu file).<br>2. `validateCommentLanguage` làm sạch các định danh/token kỹ thuật và từ chối (`SUMMARY_REQUIRED` với thông báo rõ ràng) khi comment mới trộn lẫn từ vựng Tiếng Việt có dấu với các hư từ/động từ chia ngôi cấu trúc câu Tiếng Anh, trong khi chấp nhận bình thường comment thuần Tiếng Việt (kèm identifier kỹ thuật) hoặc thuần Tiếng Anh.<br>3. Cập nhật thông báo lỗi và `buildConventionReminder` trong `agent-lifecycle-tools.js` hướng dẫn viết comment chi tiết thuần ngôn ngữ. | Phụ thuộc helper tại `agent-code-conventions.js` (`O1`). |
| O3 | Mở rộng thu thập trọn vẹn khối Comment chi tiết phía trên symbol trong Indexer | 1. Trong `indexContent` (`index-record-writer.js`), gỡ bỏ giới hạn quét ngược 3 dòng (`start - 4`); thu thập toàn bộ khối comment liên tiếp phía trên symbol (cả `//`, `#` nhiều dòng và khối `/* ... */`, `<!-- ... -->`) với biên chặn dưới `prevSymbolEndLine` và không lấy nhầm file header comment khi hàm không có comment riêng.<br>2. Toàn bộ nội dung comment thu thập được đưa vào `symbol_content_fts` và truyền sang `queueSymbolEmbedding` (trong giới hạn 4000 ký tự). | — |
| O4 | Đồng bộ hóa Prompt của Agent và Tài liệu quy chuẩn của Repository | 1. `nodeforge-task-prompts.js` bỏ ép buộc cứng chỉ dùng Tiếng Anh cho comment; hướng dẫn viết comment chi tiết (business purpose + technical description) bằng Tiếng Anh hoặc Tiếng Việt thuần nhất (không trộn lẫn) và giải thích rõ giới hạn 250 dòng tính theo `code_lines` (không tính comment và dòng trống).<br>2. `CLAUDE.md`, `AGENTS.md`, `workflows/agents/coder/README.md`, và `workflows/agents/reviewer/README.md` được cập nhật đồng bộ với hai quy tắc trên. | — |

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Comment Tiếng Việt có chứa tên hàm, tên biến, hoặc thuật ngữ kỹ thuật Tiếng Anh (ví dụ: `write_diff`, `read_file`, `sha256`, `camelCase`) bị bắt nhầm là trộn Anh – Việt | Major | Đã phân tích tại Góp ý 4 trong `workflows/plan-comment-language-and-line-budget-feedback.md` | SL / Coder chuẩn hóa bước strip token kỹ thuật (backtick, quotes, URL, path, JSDoc tags, `camelCase`, `PascalCase`, `snake_case`, `UPPER_SNAKE_CASE`, `fn()`) trước khi so khớp danh sách hư từ/động từ chia ngôi cấu trúc câu Tiếng Anh. |
| Dòng hỗn hợp (code + block comment) hoặc `#privateField` của JS/TS làm sai lệch `countBudgetLines`, hoặc JSDoc kết thúc bằng `*/` bị `hasPrecedingComment` từ chối | Major | Đã phân tích tại Góp ý 1 & 3 trong `workflows/plan-comment-language-and-line-budget-feedback.md` | Dùng `stripCommentsFromLine(line, state)` bóc tách comment trước khi kiểm tra `trim().length > 0`, và dùng `extractPrecedingCommentBlock` quét ngược từ `*/` / `-->` về `/*` / `<!--`. |

## 7. Acceptance criteria của plan

- [x] Mục tiêu, in/out scope và outcomes nhất quán với yêu cầu của Owner và phản hồi kỹ thuật của SE.
- [x] Facts repository-specific có evidence và SHA-256 đầy đủ; assumptions và rủi ro được ghi rõ.
- [x] Guardrails và dependency bắt buộc tách khỏi gợi ý delivery.
- [x] Outcomes (`O1`–`O4`) có tiêu chí kiểm tra được và đủ để SL lập Sprint Plan chủ động.
- [x] Không áp đặt số ticket, tên ticket hoặc mutable-file manifest cố định.
- [x] SL phải chứng minh coverage và tuân thủ policy ticket hiện hành trước dispatch.
- [x] Approval đúng identity/revision/SHA-256; lập SP không tự RUN/dispatch.

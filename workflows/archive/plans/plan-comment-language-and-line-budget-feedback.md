<!-- Đánh giá kỹ thuật và góp ý chi tiết của System Engineer cho kế hoạch chuẩn hóa quy ước comment chi tiết thuần ngôn ngữ và ngân sách 250 dòng (loại trừ comment & dòng trống). -->
# Technical Review & Feedback: Chuẩn hóa Comment chi tiết thuần ngôn ngữ và Ngân sách 250 dòng (`code_lines`)

**Tài liệu đối chiếu:** `workflows/plan-comment-language-and-line-budget.md`  
**Người đánh giá:** System Engineer (SE)  
**Trạng thái đánh giá:** Đồng thuận hoàn toàn với mục tiêu và cấu trúc Outcomes `O1`–`O4`; đề xuất bổ sung 6 điểm kỹ thuật chi tiết để xử lý triệt để các edge cases trong parser, tool lifecycle và indexer.

---

## 1. Đánh giá tổng quan

Bản kế hoạch `workflows/plan-comment-language-and-line-budget.md` giải quyết trực diện mâu thuẫn cố hữu giữa **chất lượng ngữ nghĩa của comment phục vụ tìm kiếm (`symbol_content_fts` & `symbol_embeddings`)** và **trần 250 dòng của mỗi file**:
- **Tách bạch rõ `total_lines` và `code_lines` (`budget_lines`):** Giữ nguyên `total_lines` (dòng vật lý) trong `read_file` giúp toàn bộ cơ chế định vị dòng (`offset`, `limit`, `start_line`, `end_line` và cửa sổ 80 dòng) không bị ảnh hưởng, trong khi chuyển cổng kiểm tra 250 dòng sang `code_lines` giúp Coder thoải mái viết comment giải thích chi tiết nghiệp vụ + kỹ thuật.
- **Khớp nối đồng bộ từ lúc viết code tới lúc đánh chỉ mục (`O2` -> `O3`):** Cho phép viết comment nhiều dòng ở `agent-code-conventions.js` đi đôi với việc gỡ trần quét ngược 3 dòng (`start - 2` đến `start - 4`) trong `index-record-writer.js` giúp toàn bộ nội dung comment chi tiết thực sự đi vào FTS và Vector Embedding.

---

## 2. 6 Góp ý kỹ thuật chi tiết (Gap Analysis & Implementation Notes)

### Góp ý 1 — Về `O1` (`countBudgetLines`): Xử lý dòng hỗn hợp (code + block comment) và ký tự `#` trong JS/TS
- **Hiện trạng & Vấn đề tiềm ẩn:**
  1. Một dòng có thể vừa đóng/mở block comment vừa chứa lệnh thực thi, ví dụ:
     - `/* comment */ export function foo() {`
     - `const a = 1; /* inline commentStart` (mở comment khối ở cuối dòng có code)
     - `end of comment */ const b = 2;` (đóng comment khối ở đầu dòng rồi viết tiếp code)
     Nếu line-scanner chỉ kiểm tra `inBlockComment` hoặc `/^(?:\/\*|\*|\*\/)/` theo đầu dòng thì sẽ loại trừ nhầm dòng có code hoặc tính nhầm dòng comment.
  2. Trong JavaScript/TypeScript (ES2022+), ký tự `#` ở đầu dòng bên trong class (ví dụ: `#privateField = 1;` hoặc `# compute() {}`) là **private class field/method**, không phải comment (trừ dòng shebang `#!/usr/bin/env node`).
- **Đề xuất giải pháp cho `O1`:**
  - Thiết kế hàm `stripCommentsFromLine(line, state)` duyệt qua từng dòng với trạng thái `state.inBlockComment` (`"/*"` hoặc `"<!--"`):
    - Bóc tách tất cả các đoạn nằm trong `/* ... */` và `<!-- ... -->` trên dòng đó.
    - Với phần văn bản nằm ngoài block comment, cắt bỏ phần inline comment từ `//` đến cuối dòng (bỏ qua `://` trong URL string đơn giản), và chỉ coi `#` là comment khi là dòng shebang `#!` hoặc dòng bắt đầu bằng `#` kèm khoảng trắng (`/^#\s/`) hoặc không phải cú pháp `#identifier` đi kèm `=`, `(`, `;`.
    - **Quy tắc đếm:** Sau khi bóc tách các đoạn comment trên dòng, nếu phần còn lại có `trim().length > 0` thì tính là **1 `code_lines`**; nếu rỗng (`trim() === ""`) thì là dòng trống/comment và được loại trừ khỏi `code_lines`.

---

### Góp ý 2 — Về `O1` & `O2` (`agent-lifecycle-tools.js`): Bổ sung kiểm tra ngân sách 250 `code_lines` cho cả `edit_diff` và đồng bộ `before_checksum`
- **Hiện trạng mã nguồn (`backend/src/tools/agent-lifecycle-tools.js:95-156`):**
  - Lưu ý nhỏ về SHA-256 trong bảng mục 4 của Plan: Sau đợt nâng cấp `O1`–`O6` vừa rồi, `backend/src/tools/agent-lifecycle-tools.js` hiện có SHA-256 mới là `sha256:90bb9af5a6ca913475e2c1b8ea5149bce99952bf6ae05e6c8be98572b0664b8f`.
  - Hiện tại chỉ có `write_diff` kiểm tra trần 250 dòng (`CONTENT_TOO_LARGE` / `DESTRUCTIVE_OVERWRITE`), còn `edit_diff` (dòng 127–156) chỉ kiểm tra `maxChars` mà **không kiểm tra xem file sau khi sửa (`replaced`) có vượt quá 250 `code_lines` hay không**.
- **Đề xuất giải pháp cho `O1`:**
  - Trong `write_diff`: Dùng `countBudgetLines(input.content)` cho `CONTENT_TOO_LARGE` và `countBudgetLines(current)` cho `DESTRUCTIVE_OVERWRITE`, đồng thời trả kèm cả `code_lines` và `total_lines` trong `error.details`.
  - Trong `edit_diff`: Nếu file trước khi sửa đang tuân thủ ngân sách (`countBudgetLines(current) <= WRITE_DIFF_MAX_LINES`) mà bản sửa `replaced` làm `countBudgetLines(replaced) > WRITE_DIFF_MAX_LINES`, trả lỗi `CONTENT_TOO_LARGE` (hoặc thông báo rõ số `code_lines` vượt trần 250) để Coder tách file helper ngay thay vì đợi đến lúc Reviewer bắt lỗi.

---

### Góp ý 3 — Về `O2` (`hasPrecedingComment` & `hasFileHeaderComment`): Sửa lỗi báo sai với JSDoc / Block Comment nhiều dòng
- **Hiện trạng mã nguồn (`backend/src/tools/agent-code-conventions.js:19-26`):**
  ```js
  export function hasPrecedingComment(content, fnName) {
    const lines = content.split("\n");
    const idx = lines.findIndex((line) => new RegExp(`\\bfunction\\s+${fnName}\\b`).test(line));
    if (idx <= 0) return false;
    const prev = lines[idx - 1]?.trim() ?? "";
    return /^(?:\/\/|\/\*|#|<!--)/.test(prev);
  }
  ```
- **Vấn đề tiềm ẩn:**
  - Khi Coder viết comment chi tiết bằng JSDoc hoặc block comment nhiều dòng:
    ```js
    /**
     * Xử lý lưu trữ báo cáo nghiệm thu...
     */
    export function saveReport() {}
    ```
    Dòng ngay trước hàm (`lines[idx - 1].trim()`) là `*/`. Biểu thức chính quy `/^(?:\/\/|\/\*|#|<!--)/` hiện tại **không khớp với `*/`** (vì bắt đầu bằng `*` chứ không phải `/*`), dẫn tới `hasPrecedingComment` trả về `false` và ném lỗi oan `SUMMARY_REQUIRED`!
- **Đề xuất giải pháp cho `O2`:**
  - Xây dựng hàm dùng chung `extractPrecedingCommentBlock(lines, targetLineIndex, minLineIndex = 0)`:
    - Bỏ qua các dòng `@decorator` hoặc dòng trống sát ngay trên hàm (tối đa 1 dòng trống nếu cần, hoặc sát liền kề).
    - Nếu dòng phía trên kết thúc bằng `*/` (hoặc `-->`), quét ngược lên tới dòng chứa `/*` (hoặc `<!--`) để trích xuất trọn vẹn cả khối comment.
    - Nếu dòng phía trên bắt đầu bằng `//` hoặc `#`, quét ngược liên tiếp tất cả các dòng `//` hoặc `#` liền kề để ghép thành một khối comment hoàn chỉnh.
  - Hàm này trả về chuỗi nội dung comment đầy đủ để dùng cho cả:
    1. Kiểm tra sự tồn tại của comment (`hasPrecedingComment`, `hasFileHeaderComment`).
    2. Kiểm tra tính thuần nhất ngôn ngữ (`validateCommentLanguage`).
    3. Thu thập comment cho Indexer (`O3`).

---

### Góp ý 4 — Về `O2` (`validateCommentLanguage`): Quy tắc nhận diện trộn ngôn ngữ Anh – Việt chính xác, không bắt nhầm thuật ngữ kỹ thuật
- **Hiện trạng & Thách thức:**
  - Một comment Tiếng Việt tốt trong dự án phần mềm luôn chứa các định danh và thuật ngữ kỹ thuật chuẩn bằng tiếng Anh, ví dụ:
    `// Khởi tạo ticket execution context và kiểm tra sha256 baseline trước khi chạy write_diff.` -> Câu này là **Tiếng Việt chuẩn**, tuyệt đối không được bắt nhầm là lỗi trộn ngôn ngữ.
  - Ngược lại, các comment kiểu code-switching lộn xộn do LLM sinh ra như:
    `// Checks whether file tồn tại và returns kết quả cho caller.` hoặc `// Handles việc tạo mới ticket when request arrives.` -> Phải bị chặn.
- **Đề xuất thuật toán `validateCommentLanguage(commentText)`:**
  1. **Bước làm sạch token kỹ thuật (Normalize & Strip):**
     - Loại bỏ các đoạn trong backticks `` `...` ``, quotes `'...'`, `"..."`, URL, đường dẫn file (`a/b/c.js`), thẻ JSDoc (`@param`, `@returns`), mã lỗi `UPPER_SNAKE_CASE`, định danh `camelCase`, `PascalCase`, `snake_case`, `kebab-case`, và từ đi kèm `()`.
  2. **Bước phân loại ngôn ngữ:**
     - Kiểm tra sự xuất hiện của ký tự Tiếng Việt có dấu (`/[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i`).
     - **Trường hợp 1 (Không có dấu Tiếng Việt):** Comment thuần Tiếng Anh -> Hợp lệ (chỉ cần đảm bảo có độ dài tối thiểu có nghĩa, ví dụ >= 3 từ).
     - **Trường hợp 2 (Có dấu Tiếng Việt):** Comment Tiếng Việt -> Kiểm tra xem phần văn bản còn lại (sau bước 1) có chứa **các hư từ / động từ chia ngôi cấu trúc câu Tiếng Anh** hay không (ví dụ: `\b(the|this|that|these|those|which|when|where|while|because|should|would|could|must|cannot|doesn't|isn't|aren't|returns|handles|creates|checks|validates|ensures|provides|determines|computes|extracts|updates|deletes|removes|allows|prevents|requires|whether|between|through|without|before|after|during)\b`).
     - Nếu vừa có từ Tiếng Việt có dấu vừa chứa các từ cấu trúc câu Tiếng Anh trên -> Từ chối với mã `SUMMARY_REQUIRED` (kèm thông báo rõ: *"Comment mixes Vietnamese and English sentence structure; write the comment entirely in English or entirely in Vietnamese (technical identifiers are allowed)."*).

---

### Góp ý 5 — Về `O3` (`index-record-writer.js`): Chặn biên dưới (`minLine`) khi quét ngược comment của symbol
- **Hiện trạng mã nguồn (`backend/src/modules/index/index-record-writer.js:41-55`):**
  - Danh sách `rows` đã được sắp xếp theo `ORDER BY start_line, name`.
- **Vấn đề tiềm ẩn:**
  - Khi gỡ bỏ giới hạn `Math.max(0, start - 4)` và cho phép bỏ qua dòng trống sát symbol, nếu một hàm/biến nội bộ **không có comment riêng**, vòng lặp quét ngược nếu bỏ qua nhiều dòng trống có thể chạm vào:
    1. Comment ở đầu file (file header comment) và gán nhầm vào hàm đầu tiên, hoặc
    2. Comment độc lập nằm ở cuối hàm phía trước.
- **Đề xuất giải pháp cho `O3`:**
  - Theo dõi `prevSymbolEndLine` khi duyệt qua `rows` (hoặc đặt biên chặn là dòng code không phải comment gần nhất phía trên).
  - Chỉ cho phép bỏ qua tối đa **1 dòng trống** sát ngay phía trên `symbol.start_line` (hoặc chỉ bỏ qua các dòng `@decorator`), và dừng ngay lập tức khi gặp bất kỳ dòng code nào hoặc dòng trống thứ hai. Như vậy khối comment nhiều dòng (dù dài 5, 10 hay 30 dòng liên tiếp) vẫn được thu thập trọn vẹn 100%, mà không bao giờ lấy nhầm header comment cách xa phía trên.

---

### Góp ý 6 — Về `O1` & `O4` (Đồng bộ hiển thị `code_lines` cho Reviewer và Unit Tests hiện hữu)
- **Tương thích với Reviewer (`reviewer-forge-tools.js` & `committed-review-window.js`):**
  - Khi thêm `code_lines: countBudgetLines(file.content)` vào `metadata` của `createReadFileTool` (`backend/src/tools/agent-lifecycle-tools.js:54`), cả Coder và Reviewer đều nhận được trường `code_lines` bên cạnh `total_lines`.
  - Ngoài ra, công cụ `read_lines` của Reviewer (`backend/src/modules/supervisor/committed-review-window.js`) và `sed_lines` của Coder (`backend/src/tools/sed-lines.js`) nếu trả về `total_lines` cũng nên đính kèm `code_lines` để Agent biết chính xác số dòng ngân sách của file dù gọi `read_file` hay `read_lines`.
- **Tương thích với Unit Tests hiện có (`backend/tests/unit/agent-lifecycle-tools-v2.test.js:96-120`):**
  - Trong `agent-lifecycle-tools-v2.test.js`, hai test `"write_diff rejects content over 250 lines with CONTENT_TOO_LARGE"` và `"write_diff rejects replacing an existing file over 250 lines"` tạo 251 dòng `"x"` (đều là dòng không trống, không phải comment) và kiểm tra `error.details.line_count === 251` / `error.details.current_lines === 251`.
  - Do 251 dòng `"x"` có `countBudgetLines === 251`, việc giữ tên trường `line_count` và `current_lines` trong `error.details` (mang giá trị `code_lines`, có thể bổ sung thêm `code_lines` và `total_lines`) sẽ giúp **100% test cũ tiếp tục PASS** mà không bị gãy contract.

---

## 3. Kết luận & Đề xuất hành động tiếp theo

Bản kế hoạch `workflows/plan-comment-language-and-line-budget.md` đã hoàn chỉnh về mặt kiến trúc và phạm vi (`O1`–`O4`).
- Nếu Owner đồng ý với 6 điểm chi tiết kỹ thuật trên, có thể hợp nhất vào `workflows/plan-comment-language-and-line-budget.md` hoặc giao SE triển khai trực tiếp `O1`–`O4` kèm bộ unit test kiểm chứng.

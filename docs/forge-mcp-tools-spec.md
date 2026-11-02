# Forge — Đặc tả bộ tool MCP cho Agent

Giai đoạn hiện tại: 1 task được giao cho agent tự chủ qua `query()` (Claude Agent SDK), dùng thuần tool MCP tự viết của Forge — không dùng tool built-in của SDK (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`).

Tên tool khi đăng ký qua `mcpServers: { forge: forgeTools }` sẽ có dạng `mcp__forge__<tên tool>`.

---

## 1. `read_file` và `Read`

**Chức năng:**
- `read_file({ path })`: Với file code (non-`.md`), trả về metadata (`sha256`, `total_lines`, `code_lines`), `symbol_map` và `code_graph` (không trả nội dung code thô); với file Markdown (`.md`), trả về metadata kèm tối đa `250` dòng đầu.
- `Read({ file_path, symbol })` / `Read({ file_path, start_line, end_line })`: Với file code, bắt buộc đọc trọn vẹn theo `symbol` từ `symbol_map` (không giới hạn số dòng của symbol, từ chối đọc theo cửa sổ dòng); với file `.md`, đọc theo cửa sổ `start_line`/`end_line` tối đa `80` dòng vật lý mỗi lần.

**Input**
```typescript
{ path: z.string() }
```
- `path`: đường dẫn tương đối từ root repo, ví dụ `"src/utils/currency.ts"`

**Output — thành công**
```typescript
{ content: [{ type: "text", text: string }] }
```
`text` = metadata kèm `symbol_map`/`code_graph` (hoặc nội dung tối đa 250 dòng đầu đối với `.md`) và `sha256` toàn file.

**Output — lỗi (file không tồn tại)**
```typescript
{ content: [{ type: "text", text: "Lỗi: không tìm thấy file tại đường dẫn '<path>'" }], isError: true }
```

quyết định: 1.dùng đúng tên phù hợp cho agent. 2.dùng File service để đọc và trả nội dung file. 3. gơi thêm checksum và yêu cầu agent trả lại checksum ở vòng write_diff
---

## 2. `search_code`

**Chức năng:** Tìm kiếm đoạn code liên quan bằng full-text search (FTS5, tận dụng Code Index có sẵn — không dùng ripgrep, không dùng Relevant Tree Selector/Context Planner). Dùng khi chưa biết chính xác file nào chứa logic cần sửa.

**Input**
```typescript
{ query: z.string() }
```
- `query`: từ khóa hoặc cụm từ, ví dụ `"formatCurrency"` hoặc `"product price display"`

**Output — có kết quả**
```typescript
{ content: [{ type: "text", text: string }] }
```
`text` = danh sách đánh số, mỗi mục gồm path + snippet, cách nhau 2 dòng trống:
```
1. src/components/ProductPrice.tsx
   »formatCurrency« được gọi khi render giá sản phẩm...

2. src/utils/currency.ts
   export function »formatCurrency«(amount: number)...
```

**Output — không có kết quả**
```typescript
{ content: [{ type: "text", text: "Không tìm thấy kết quả nào khớp với từ khóa này." }] }
```

Ghi chú: không trả điểm `rank`/`score` số thô cho agent đọc (bm25 rank âm, dễ hiểu ngược) — thứ tự trong danh sách (đã `ORDER BY rank`) đã thể hiện độ ưu tiên.

quyết định: dổi cho phù hợp với agent
---

## 3. `write_diff` và `edit_diff`

**Chức năng:**
- `write_diff`: Ghi toàn bộ nội dung một file sau khi kiểm tra `before_checksum`. Áp dụng giới hạn tối đa `250` dòng cho file Markdown (`.md`) và tối đa `400` `code_lines` (không tính dòng trống và dòng chỉ chứa comment) cho file code (non-`.md`). Từ chối nếu vượt ngưỡng (`CONTENT_TOO_LARGE` / `DESTRUCTIVE_OVERWRITE`) hoặc nếu path nằm trong danh sách bảo vệ.
- `edit_diff`: Thay thế đoạn mã cục bộ theo `anchor` chính xác kèm kiểm tra `before_checksum` và ngưỡng `250` dòng cho `.md` / `400` `code_lines` cho file code.

**Input**
```typescript
{ path: z.string(), content: z.string(), before_checksum: z.string().nullable() }
```
- `path`: đường dẫn file cần ghi
- `content`: toàn bộ nội dung file mới
- `before_checksum`: `sha256` toàn file từ `read_file`/`Read` (hoặc `null` khi tạo file mới)

**Output — thành công**
```typescript
{ content: [{ type: "text", text: "Đã ghi thành công vào '<path>'" }] }
```

**Output — bị chặn (protected path)**
```typescript
{ content: [{ type: "text", text: "TỪ CHỐI: '<path>' nằm trong danh sách file được bảo vệ, không thể ghi đè." }], isError: true }
```

**Output — lỗi hệ thống**
```typescript
{ content: [{ type: "text", text: "Lỗi khi ghi file: <error.message>" }], isError: true }
```
quyết định: 1. agent cần trả lại checksum. 2. node chiu trách nhiệm ghi file qua file service.
---

## 4. `run_test`

**Chức năng:** Chạy test suite thật của dự án để xác minh thay đổi không làm hỏng gì. Bắt buộc gọi trước khi `report_done`.

**Input**
```typescript
{}
```
Không tham số.

**Output — pass**
```typescript
{ content: [{ type: "text", text: "PASS: <n> test đã chạy, tất cả thành công." }] }
```

**Output — fail**
```typescript
{ content: [{ type: "text", text: "FAIL: <n> test thất bại.\n\n<danh sách tên test + lỗi>" }], isError: true }
```
quyết định; node chạy run_test và trả kết quả cho agent.
---

## 5. `commit_changes`

**Chức năng:** Commit các thay đổi đã ghi vào git trên branch của ticket. Chỉ nên gọi sau khi `run_test` đã pass.

**Input**
```typescript
{ message: z.string() }
```
- `message`: commit message ngắn gọn mô tả thay đổi

**Output — thành công**
```typescript
{ content: [{ type: "text", text: "Đã commit: <commit hash ngắn> — '<message>'" }] }
```

**Output — lỗi (không có gì để commit)**
```typescript
{ content: [{ type: "text", text: "Không có thay đổi nào để commit." }], isError: true }
```
quyết định: node chịu trách nhiệm commit và trả kết quả cho agent
---

## 6. `report_done`

**Chức năng:** Báo hiệu task đã hoàn tất. Bắt buộc gọi khi kết thúc, kèm tóm tắt thay đổi đã thực hiện. Đây là tín hiệu dừng cho Node — không có logic xử lý phức tạp bên trong.

**Input**
```typescript
{ summary: z.string() }
```
- `summary`: tóm tắt ngắn gọn — đã sửa gì, ở đâu, tại sao

**Output**
```typescript
{ content: [{ type: "text", text: "Đã ghi nhận báo cáo hoàn tất." }] }
```

Node đọc `summary` qua transcript message chứa tool call `report_done`, không cần xử lý gì thêm từ phía tool.

quyết định: tái sử dụng được phần report hoàn toàn. Tool report_done nối vào backend/src/modules/supervisor/completion-report-service.js, không cần xây lại Giai đoạn 6.
---

## Quy tắc nhất quán

- Mọi lỗi đều set `isError: true` kèm text mô tả rõ nguyên nhân.
- Chọn **một ngôn ngữ duy nhất** cho toàn bộ thông báo lỗi/kết quả (đừng trộn Việt–Anh) — vì đây là nội dung agent đọc để tự quyết định bước tiếp theo; câu chữ không nhất quán dễ khiến agent phản ứng sai (retry vô nghĩa hoặc bỏ cuộc sớm).
- Tool built-in của SDK (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`) nên được thêm vào `disallowedTools` để chặn cứng, không chỉ dựa vào việc không liệt kê trong `allowedTools`.

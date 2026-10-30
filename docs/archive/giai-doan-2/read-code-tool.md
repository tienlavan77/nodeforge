# Kế hoạch xây dựng Tool `read_code`

## 1. Mục tiêu và phạm vi

Xây dựng một Forge Tool Lab tool read-only để Agent đọc mã nguồn theo **file** hoặc
**symbol**. Tool được phát triển, phân quyền và kiểm thử độc lập; chưa đưa vào Supervisor,
Sender Worker, R1, R2, R3 hoặc production pipeline.

Mục tiêu an toàn quan trọng nhất là Agent chỉ đọc đúng tài nguyên đã được Node cấp. Tool
không được suy đoán path, mở rộng prefix, đọc dependency liên quan hoặc tự truy cập
filesystem.

## 2. Contract đề xuất

Tên tool: `read_code`  
Capability: `read_code`

Input:

```json
{
  "kind": "file",
  "path": "frontend/src/components/Header.jsx",
  "symbol": null,
  "start_line": null,
  "end_line": null,
  "max_chars": 50000
}
```

- `kind` chỉ nhận `file` hoặc `symbol`.
- `path` là path tương đối, bắt buộc phải xuất hiện chính xác trong allowlist Node cấp.
- Với `file`, Agent nhận toàn bộ nội dung của đúng path đó.
- Với `symbol`, Agent phải dùng path và symbol range đã được Node cấp; không cho Agent tự
  đặt range ngoài symbol được duyệt.
- `symbol` là tên symbol đã được duyệt; `start_line` và `end_line` phải khớp entry Node cấp.
- `max_chars` có giới hạn cứng; không cho Agent vượt giới hạn service.
- `additionalProperties: false`; không nhận SQL, glob, absolute path, ref nội bộ hoặc content.

Context do Node cấp (không phải dữ liệu Agent tự tin cậy):

```json
{
  "task_id": "TASK-1",
  "capabilities": ["read_code"],
  "allowed_file_paths": ["frontend/src/components/Header.jsx"],
  "allowed_symbols": [
    {
      "path": "frontend/src/components/Header.jsx",
      "name": "Header",
      "symbol_kind": "function",
      "start_line": 1,
      "end_line": 35
    }
  ]
}
```

`allowed_file_paths` là exact allowlist. `allowed_symbols` cũng phải được kiểm tra theo
đúng tuple `path + name + start_line + end_line`; không chấp nhận symbol tương tự ở file
khác hoặc range do Agent sửa.

## 3. Kết quả và lỗi

Kết quả file:

```json
{
  "task_id": "TASK-1",
  "kind": "file",
  "path": "frontend/src/components/Header.jsx",
  "content": "...toàn bộ nội dung...",
  "language": "javascript",
  "sha256": "...",
  "size_bytes": 1771,
  "truncated": false
}
```

Kết quả symbol có thêm `name`, `symbol_kind`, `start_line`, `end_line`; `content` chỉ là
đoạn dòng của symbol, không phải toàn bộ file. Nếu chạm giới hạn ký tự, trả cờ `truncated`
và không âm thầm trả phần chưa được kiểm soát.

Mã lỗi chuẩn:

- `TOOL_FORBIDDEN`: thiếu capability `read_code`.
- `TOOL_SCOPE_INVALID`: thiếu hoặc sai `task_id`, allowlist Node không hợp lệ.
- `READ_KIND_INVALID`: kind ngoài `file|symbol`.
- `READ_PATH_FORBIDDEN`: path không có trong exact allowlist, traversal, absolute, ignored hoặc secret.
- `READ_SYMBOL_FORBIDDEN`: symbol/range không có trong danh sách Node duyệt.
- `READ_LIMIT_INVALID`: `max_chars` ngoài khoảng cho phép.
- `READ_FILE_NOT_FOUND`: Forge File Service không tìm thấy file đã duyệt.
- `READ_BACKEND_ERROR`: lỗi còn lại từ Forge File Service.

## 4. Kiến trúc triển khai

1. Tạo input schema `schemas/agent/tools/read-code.schema.json` và result schema
   `schemas/agent/tools/read-code-result.schema.json`; dùng `additionalProperties: false`,
   enum, giới hạn chuỗi/số và cấu trúc symbol rõ ràng.
2. Tạo `backend/src/tools/read-code.js`; inject Forge File Service, không import `fs`,
   database hoặc Supervisor.
3. Trước khi gọi service, kiểm tra capability/task scope, exact path allowlist và symbol
   tuple. Không đưa path hoặc range mới do Agent tự tạo vào service.
4. Đọc file qua API Forge File Service hiện có để nhận content, language, checksum và size.
   Với symbol, cắt theo range đã được Node duyệt sau khi file đã được đọc; bảo đảm line range
   không vượt file và không cho range âm/đảo.
5. Xóa khỏi output mọi field nội bộ, content ngoài range, SQL, absolute path hoặc metadata
   không thuộc result schema.
6. Mở rộng Tool Lab registry có điều kiện bằng dependency injection `fileService`; chưa thêm
   tool vào provider schemas hoặc production runtime.

## 5. Prompt/contract cho Agent

Prompt của tool phải nói rõ:

- Chỉ gọi `read_code` cho path/symbol Agent thực sự cần.
- Chỉ dùng path và symbol có trong Node-provided allowlist.
- Không đoán path, không tự mở rộng prefix, không đọc file liên quan và không gọi filesystem.
- `file` trả toàn bộ file được duyệt; `symbol` chỉ trả đoạn symbol được duyệt.
- Sau khi nhận kết quả, tiếp tục suy luận; tool không tự kết thúc task.

Mỗi lần gọi chỉ phục vụ một resource để dễ audit và ngăn Agent gộp yêu cầu ngoài phạm vi.

## 6. Kiểm thử độc lập

Tạo `backend/tests/tools/read-code.test.js` với các nhóm:

- đọc file hợp lệ và giữ nguyên checksum/language/size;
- đọc symbol hợp lệ đúng line range;
- từ chối path không có trong allowlist, path traversal, absolute path, ignored/secret path;
- từ chối symbol khác file, khác tên hoặc khác line range;
- từ chối thiếu capability, thiếu/sai task id, kind/query/limit sai;
- kiểm tra không thể yêu cầu file thứ hai trong cùng input và không có field ngoài schema;
- kiểm tra giới hạn/truncation và mapping lỗi File Service;
- kiểm tra registry không khởi tạo nếu thiếu Forge File Service.

Tạo harness `backend/scripts/test-read-code-tool.mjs` gồm:

- `--dry-run`: fixture File Service, không gọi Agent ngoài;
- normal mode: gọi Agent Gateway trực tiếp với duy nhất `read_code`, nhận tool call và thực
  thi qua Tool Lab registry;
- in `local_pass` và `agent_tool_call_pass`;
- không khởi động Supervisor, Sender Worker hoặc Stage-1.

Kiểm tra bằng Node syntax check, unit tests, AJV cho hai schema, dry-run và một lần real-agent
call có credential được cấu hình.

## 7. Điều kiện hoàn tất và tích hợp sau

Tool chỉ được đánh dấu hoàn tất khi schema, authorization, exact allowlist, unit/security test,
dry-run và real-agent harness đều pass. Sau đó, và chỉ khi có phê duyệt riêng, mới thiết kế
adapter để nối `read_code` vào pipeline chung cùng `search_code`, `select_code_graph_candidates`
và `read_transcript_blocks`.

## 8. Áp dụng tám nguyên tắc Context Access

`read_code` dùng chung `backend/src/tools/retrieval-governance.js`: kiểm tra
`execution_scope`, reserve/consume `context_budget` hoặc `retrieval_budget`, giới hạn số lần
retrieval và phát audit event/callback. Vì vậy exact allowlist không phải quyền vô hạn; tổng
bytes và số lần gọi vẫn do Node Runtime sở hữu. Tool chỉ trả content khi Agent chủ động yêu
cầu, không dump repository và không phân tích thay Agent.

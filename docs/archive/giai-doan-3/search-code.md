# Kế hoạch Tool `search_code`

## Mục tiêu

Xây dựng một tool read-only cho Agent tìm kiếm metadata trong Forge Code Search. Tool hỗ trợ hai chế độ: tìm theo file và tìm theo symbol. Tool được phát triển, phân quyền và kiểm thử độc lập trong Tool Lab; chưa kết nối vào Supervisor, R1, R2, R3 hoặc pipeline production.

## Contract

Tên tool: `search_code`

Capability: `search_code`

Input dự kiến:

```json
{
  "query": "Header",
  "kind": "symbol",
  "limit": 20,
  "allowed_prefixes": ["frontend/"]
}
```

- `query`: bắt buộc, chuỗi không rỗng, có giới hạn độ dài.
- `kind`: chỉ nhận `file` hoặc `symbol`.
- `limit`: giới hạn số kết quả, tối thiểu 1 và tối đa 50.
- `allowed_prefixes`: scope do Node cấp; Agent không được tự mở rộng scope.
- Không nhận SQL, glob tùy ý, path tuyệt đối hoặc nội dung code.

## Kết quả

Kết quả chỉ gồm metadata từ Code Index, không gồm full content:

```json
{
  "task_id": "TASK-1",
  "query": "Header",
  "kind": "symbol",
  "index_version": "IDX-42",
  "matches": [
    {
      "kind": "symbol",
      "path": "frontend/src/components/Header.jsx",
      "name": "Header",
      "symbol_kind": "component",
      "score": 0.98,
      "reason": ["symbol_exact:header"],
      "start_line": 12,
      "end_line": 46
    }
  ]
}
```

File match trả `path`, `language`, `sha256`, `size_bytes`, `score` và `reason`. Symbol match trả thêm `name`, `symbol_kind`, `start_line` và `end_line`.

## Kiến trúc triển khai

1. Tạo schema input tại `schemas/agent/tools/search-code.schema.json`.
2. Tạo schema result tại `schemas/agent/tools/search-code-result.schema.json`.
3. Tạo implementation tại `backend/src/tools/search-code.js`.
4. Inject Forge `Code Search`; tool không tự query SQLite và không đọc filesystem.
5. Dùng API hiện có `codeSearch.search({ query, kind, limit })`.
6. Lọc kết quả theo `allowed_prefixes` do Node cấp.
7. Gắn `task_id`, `index_version` và metadata node vào kết quả.
8. Đăng ký trong Tool Lab registry, chưa đưa vào pipeline production.

## Phân quyền và an toàn

- Bắt buộc capability `search_code`.
- Bắt buộc `task_id` hợp lệ.
- Chỉ cho phép `kind=file|symbol`.
- Giới hạn query và limit trước khi gọi Code Search.
- Không cho phép path ngoài `allowed_prefixes`.
- Không trả secret, ignored path hoặc full content.
- Giữ nguyên score, reason và `index_version` do Code Index cung cấp; Agent không được sửa metadata.

## Kiểm thử độc lập

Tạo harness `backend/scripts/test-search-code-tool.mjs` với hai chế độ:

```bash
node backend/scripts/test-search-code-tool.mjs --dry-run
node backend/scripts/test-search-code-tool.mjs
```

Test phải bao phủ:

- tìm theo `file`;
- tìm theo `symbol`;
- kết quả được giới hạn theo `limit`;
- lọc đúng `allowed_prefixes`;
- thiếu capability (`TOOL_FORBIDDEN`);
- thiếu hoặc sai `task_id` (`TOOL_SCOPE_INVALID`);
- `kind` không hợp lệ (`SEARCH_KIND_INVALID`);
- query rỗng/quá dài (`SEARCH_QUERY_INVALID`);
- limit ngoài khoảng (`SEARCH_LIMIT_INVALID`);
- không trả full content hoặc path bị ignore;
- Code Search lỗi được chuyển thành lỗi tool có mã rõ ràng.

Chế độ agent thật chỉ gọi Agent Gateway trực tiếp với tool `search_code`, nhận tool call và thực thi qua Tool Lab registry. Không khởi động Supervisor, Sender Worker hoặc Stage-1 pipeline.

## Luồng sử dụng sau khi tích hợp

```text
search_code(file|symbol)
  -> select_code_graph_candidates
  -> read_transcript_blocks / Forge File Service
```

Chỉ sau khi schema, authorization, unit/security test, dry-run và agent test đạt mới ghép tool vào pipeline chung.

## Governance Context Access

`search_code` không trả source content và dùng exact scope do Node cấp. Khi Runtime truyền
`context_budget`/`retrieval_budget`, tool kiểm tra quota trước truy vấn, cập nhật consumption sau
truy vấn và gọi `audit_retrieval`. `execution_scope.task_id` phải khớp `task_id`; không có API
dump toàn repository.

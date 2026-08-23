# Schema Request/Response cho Agent ChatGPT (Responses API) — Forge

**Schema ID:** FORGE-SCHEMA-014-OAI
**Provider:** ChatGPT (Responses API)
**Liên quan:** FORGE-SCHEMA-014 (bản Claude), Schema v1.2

---

## 1. Khác biệt cốt lõi so với Claude

| | Claude (Messages API) | ChatGPT (Responses API) |
|---|---|---|
| Cơ chế đánh dấu cache | `cache_control: {type: "ephemeral"}` gắn vào 1 content block | `prompt_cache_breakpoint: true` gắn vào **từng** content block muốn cache |
| Định danh phiên cache | Ngầm định qua nội dung khớp | Tường minh qua `prompt_cache_key` — 1 key cố định cho cùng 1 "loại" task/agent |
| TTL | Mặc định ngắn (phút), không khai báo | Khai báo tường minh: `prompt_cache_options: { mode: "explicit", ttl: "30m" }` |
| Vai trò `role` | `system` / `user` / `assistant` | `developer` (tương đương system) / `user` / `assistant` |
| Nhiều breakpoint | Tối đa 4, đặt cuối khối | Đặt trên mỗi block muốn cache riêng — cache nhiều tầng độc lập |

## 2. Request Schema (Node → Agent ChatGPT)

```json
{
  "schema_version": "1.4-oai",
  "task_id": "task_8f3a2b",
  "step_id": 3,
  "provider": "chatgpt",
  "model": "gpt-5.6",
  "cache_config": {
    "prompt_cache_key": "nodeforge-builder",
    "mode": "explicit",
    "ttl": "30m"
  },
  "developer_blocks": [
    {
      "block_id": "builder_rules",
      "content": "<BUILDER_RULES: coding convention, output format bắt buộc>",
      "cacheable": true
    },
    {
      "block_id": "project_tree",
      "content": "<PROJECT_TREE: cây thư mục rút gọn>",
      "cacheable": true
    }
  ],
  "user_blocks": [
    {
      "block_id": "task_context",
      "content": "<TASK: objective + constraints của task tổng>",
      "cacheable": false
    },
    {
      "block_id": "current_request",
      "content": "<CURRENT_ROUND_REQUEST: instruction + file liên quan của step hiện tại>",
      "cacheable": false
    }
  ],
  "expected_output": {
    "type": "diff",
    "format": "json"
  },
  "metadata": {
    "retry_of_step": null,
    "previous_error": null
  }
}
```

**Nguyên tắc:** lớp build-request của Node duyệt qua `developer_blocks`/`user_blocks`; block nào có `cacheable: true` thì tự động gắn `prompt_cache_breakpoint: true` khi map sang `input` thật của OpenAI — data-driven từ schema, không hardcode trong code.

## 3. Response Schema (Agent ChatGPT → Node)

```json
{
  "schema_version": "1.4-oai",
  "task_id": "task_8f3a2b",
  "step_id": 3,
  "provider": "chatgpt",
  "status": "success",
  "changes": [
    {
      "file_path": "assets/js/components/DocumentViewer.js",
      "action": "modify",
      "diff": "...",
      "checksum_before": "sha256:a1b2c3..."
    }
  ],
  "explanation": "...",
  "next_step_suggestion": "...",
  "questions": [],
  "confidence": "high",
  "usage": {
    "cached_tokens": 842,
    "input_tokens": 156,
    "output_tokens": 320
  }
}
```

- `usage.cached_tokens`: tương đương `cache_read_input_tokens` bên Claude — map lại từ field usage gốc của OpenAI (thường nằm trong `usage.prompt_tokens_details.cached_tokens` tùy version API) để đồng nhất tên field cho hệ thống monitor chung của Forge.

## 4. Quản lý lịch sử hội thoại (`conversation_mode`)

Tương đương mục 4 trong `FORGE-SCHEMA-014.md` (bản Claude) — cùng nguyên tắc, khác cách nhúng vào request theo cấu trúc `developer_blocks`/`user_blocks` của Responses API.

**Nhắc lại nguyên tắc cốt lõi:** dù chọn `conversation_mode` nào, vẫn **không có session/socket thật giữ mở** giữa Node và ChatGPT — mỗi round vẫn là 1 HTTPS request độc lập. `prompt_cache_key` chỉ giúp server tái sử dụng phần prompt trùng khớp, không phải cơ chế lưu trạng thái hội thoại.

### 4.1. Thêm field `conversation_mode` vào request envelope

```json
{
  "schema_version": "1.4-oai",
  "task_id": "task_8f3a2b",
  "step_id": 3,
  "provider": "chatgpt",
  "model": "gpt-5.6",
  "conversation_mode": "hybrid",
  "cache_config": {
    "prompt_cache_key": "nodeforge-builder",
    "mode": "explicit",
    "ttl": "30m"
  },
  "developer_blocks": [
    { "block_id": "builder_rules", "content": "...", "cacheable": true },
    { "block_id": "project_tree", "content": "...", "cacheable": true }
  ],
  "transcript_blocks": [
    {
      "round": 1,
      "block_id": "round_1",
      "instruction": "...",
      "response_summary": "...",
      "full_request_ref": "task_8f3a2b/round_1/request.json",
      "full_response_ref": "task_8f3a2b/round_1/response.json",
      "cacheable": false
    },
    {
      "round": 2,
      "block_id": "round_2",
      "instruction": "...",
      "response_summary": "...",
      "full_request_ref": "task_8f3a2b/round_2/request.json",
      "full_response_ref": "task_8f3a2b/round_2/response.json",
      "cacheable": false
    }
  ],
  "user_blocks": [
    { "block_id": "current_request", "content": "...", "cacheable": false }
  ],
  "expected_output": { "type": "diff", "format": "json" },
  "metadata": { "retry_of_step": null, "previous_error": null }
}
```

### 4.2. 3 giá trị hợp lệ của `conversation_mode` (giống bản Claude)

| Giá trị | Node gửi gì trong `transcript_blocks[]` mỗi round | Phù hợp |
|---|---|---|
| `full_transcript` | Toàn bộ `instruction` + response gốc của **mọi round** từ đầu task | Task ngắn (≤ 5-6 round), cần độ chính xác cao |
| `rolling_summary` | Chỉ `response_summary` đã tóm tắt cho **mọi round** | Task dài, ưu tiên tiết kiệm token |
| `hybrid` | Full nội dung cho N round gần nhất (`hybrid_window`, đặt trong `metadata`), round cũ hơn chỉ giữ `response_summary` | Mặc định khuyến nghị |

### 4.3. Quy tắc khác biệt riêng cho ChatGPT adapter

- `transcript_blocks[]` **luôn đặt `cacheable: false`** — vì nội dung đổi mỗi round, gắn `prompt_cache_breakpoint: true` vào đây sẽ luôn cache-miss, không mang lại lợi ích, chỉ tốn thêm 1 breakpoint (giới hạn tối đa breakpoint theo request nếu OpenAI áp dụng ràng buộc số lượng).
- Vị trí `transcript_blocks[]` trong request nên đặt **giữa** `developer_blocks` (cacheable, đứng đầu) và `user_blocks` (current round, đứng cuối) — giữ đúng thứ tự "phần ổn định trước, phần đổi sau" để không phá cache của `developer_blocks` khi transcript dài dần theo mỗi round.
- `full_request_ref`/`full_response_ref` dùng chung cơ chế lưu trữ ngoài với bản Claude (`task_id/round_N` trên file/DB) — không nhân đôi cách lưu theo từng provider, tránh 2 nguồn dữ liệu lệch nhau khi 1 task có thể đổi provider giữa chừng (VD retry bằng agent khác).

## 5. Nguyên tắc dùng chung envelope cho nhiều provider

```
Node internal schema (chung, không đổi theo provider)
        │
        ├── Claude Adapter  → build "system" + "cache_control" + "transcript" trong messages
        │
        └── ChatGPT Adapter → build "developer" blocks + "prompt_cache_breakpoint" + "prompt_cache_key" + "transcript_blocks"
```

- `changes[]`, `status`, `questions[]`, `confidence`, `conversation_mode` — giữ nguyên cấu trúc dù dùng Claude hay ChatGPT, vì đây là phần Node xử lý logic (apply diff, route lỗi, quản lý lịch sử), không phụ thuộc provider.
- Chỉ phần **cache mechanism**, **role naming** (`system` vs `developer`), và **cách nhúng transcript** (`transcript` array trong `messages` vs `transcript_blocks` riêng) khác biệt — cô lập trong lớp adapter; đổi provider chỉ cần đổi adapter, không đổi logic xử lý response ở tầng trên.

## 6. Lưu ý khi vận hành

- `prompt_cache_key` (VD `"nodeforge-builder"`) nên **cố định theo loại agent/role** (mọi task "builder" dùng chung 1 key), không đổi theo `task_id` — mục đích là gom nhiều task cùng loại vào chung 1 cache pool; đổi theo từng task sẽ làm mất tác dụng cache giữa các task khác nhau nhưng cùng loại rule.
- `developer_blocks` nên xếp theo thứ tự ổn định nhất trước (VD `builder_rules` trước `project_tree`) nếu `project_tree` có khả năng đổi thường xuyên hơn — tránh invalidate cache của phần ít đổi khi phần sau nó đổi.
- Khi `conversation_mode = full_transcript` hoặc `hybrid` và tổng token vượt ngưỡng context window, Node phải tự động hạ cấp round cũ nhất (full → summary) và ghi log — giống quy tắc đã áp dụng cho bản Claude, không được âm thầm cắt bỏ dữ liệu.

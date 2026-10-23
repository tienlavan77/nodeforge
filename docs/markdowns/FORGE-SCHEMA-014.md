# Ticket: Cập nhật Schema Request/Response hỗ trợ `cache_control` cho Claude API

**Ticket ID:** FORGE-SCHEMA-014
**Type:** Schema Enhancement
**Priority:** Medium
**Liên quan:** Schema v1.2 (envelope Request/Response Node ↔ Agent)

---

## 1. Mục tiêu

Tách `context` trong Request Schema thành các block độc lập, cho phép đánh dấu `cache_control` ở tầng build-request (Node), giảm chi phí/token khi các bước (`step_id`) liên tiếp trong cùng `task_id` dùng lại `objective`, `constraints`, `project_structure` không đổi.

## 2. Vấn đề hiện tại

- `context` đang là 1 object gộp chung (`objective`, `constraints`, `history_summary`) nằm trực tiếp trong `messages` — không có ranh giới rõ để Node biết phần nào "ổn định" (nên cache) và phần nào "đổi mỗi step" (không nên cache).
- Nếu để nguyên, khi implement caching sẽ phải sửa lại logic build-request từ đầu, dễ set nhầm breakpoint vào phần hay đổi (VD `instruction`, `files.content` của step hiện tại) → cache miss vô nghĩa, tốn thêm phí thay vì tiết kiệm.

## 3. Thay đổi đề xuất

### 3.1. Request Schema — tách `context` thành 2 nhóm rõ ràng

| Nhóm | Field | Đặc tính | Có nên cache? |
|---|---|---|---|
| `stable_context` | `objective`, `constraints`, `project_structure` | Không đổi trong suốt `task_id` | ✅ Có — set `cache_control: ephemeral` ở block cuối nhóm |
| `dynamic_context` | `instruction`, `files[]`, `history_summary`, `metadata` | Đổi theo từng `step_id` | ❌ Không — luôn nằm ngoài breakpoint |

### 3.2. Thêm field mới ở request envelope

```json
{
  "schema_version": "1.3",
  "task_id": "...",
  "step_id": 3,
  "cache_enabled": true,
  "stable_context": {
    "objective": "...",
    "constraints": [...],
    "project_structure": "...",
    "_cache_control": "ephemeral"
  },
  "dynamic_context": {
    "instruction": "...",
    "files": [...],
    "history_summary": "...",
    "metadata": {...}
  }
}
```

- `cache_enabled`: cờ bật/tắt caching cho task này (không phải task nào cũng đáng cache — task ngắn 1-2 step thì không cần).
- `_cache_control`: metadata nội bộ để lớp build-request (Node) biết chèn `cache_control: {type: "ephemeral"}` vào đúng content block khi gọi API — **không phải field gửi thẳng cho Claude**, chỉ dùng nội bộ giữa các module của Forge.

### 3.3. Response Schema — bổ sung field theo dõi hiệu quả cache

```json
{
  "schema_version": "1.3",
  "task_id": "...",
  "step_id": 3,
  "status": "success",
  "usage": {
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 842,
    "input_tokens": 156,
    "output_tokens": 320
  },
  "changes": [...],
  "explanation": "...",
  "confidence": "high"
}
```

- `usage.cache_read_input_tokens` > 0 → xác nhận cache đã trúng ở step này, dùng để log/monitor hiệu quả caching theo task.
- Field này lấy trực tiếp từ `usage` trong response gốc của Anthropic API, Node chỉ cần map lại vào envelope.

### 3.4. Ràng buộc validate bắt buộc (Node-side)

- `stable_context` giữa các step trong cùng `task_id` **phải giống hệt từng ký tự** — nếu Node phát hiện thay đổi (VD `constraints` được cập nhật giữa chừng task), phải tăng version nội bộ và **chấp nhận cache miss** cho lần gọi đó, không được cố giữ cache cũ (tránh agent nhận context sai).
- `cache_enabled = true` chỉ nên bật khi task có ≥ 3 step dự kiến (task ngắn không đủ lợi ích, thêm phức tạp không cần thiết).

## 4. Quản lý lịch sử hội thoại (`conversation_mode`)

**Vấn đề bổ sung:** `history_summary` (trong `dynamic_context`) mặc định là bản tóm tắt — tiết kiệm token nhưng có rủi ro mất chi tiết quan trọng nếu tóm tắt không đủ tốt. Cần cho phép Node chọn chế độ quản lý lịch sử phù hợp theo độ dài/độ phức tạm của task, thay vì chỉ có 1 lựa chọn cố định.

**Lưu ý quan trọng:** dù chọn chế độ nào, vẫn **không tồn tại session/socket thật giữ mở giữa Node và Agent** — mỗi round vẫn là 1 HTTPS request độc lập (API stateless). "Giữ session" ở đây chỉ nghĩa là **Node tự lưu trữ và tái gửi lại lịch sử** theo cấu trúc bên dưới; agent không tự nhớ gì giữa các lần gọi.

### 4.1. Thêm field `conversation_mode` vào request envelope

```json
{
  "schema_version": "1.4",
  "task_id": "task_8f3a2b",
  "step_id": 3,
  "conversation_mode": "hybrid",
  "cache_enabled": true,
  "stable_context": { "...": "như mục 3.2" },
  "transcript": [
    {
      "round": 1,
      "instruction": "...",
      "response_summary": "...",
      "full_request_ref": "task_8f3a2b/round_1/request.json",
      "full_response_ref": "task_8f3a2b/round_1/response.json"
    },
    {
      "round": 2,
      "instruction": "...",
      "response_summary": "...",
      "full_request_ref": "task_8f3a2b/round_2/request.json",
      "full_response_ref": "task_8f3a2b/round_2/response.json"
    }
  ],
  "dynamic_context": { "...": "như mục 3.2, instruction/files của step hiện tại" }
}
```

### 4.2. 3 giá trị hợp lệ của `conversation_mode`

| Giá trị | Node gửi gì trong `transcript[]` mỗi round | Phù hợp |
|---|---|---|
| `full_transcript` | Toàn bộ nội dung đầy đủ (`instruction` + response gốc) của **mọi round** từ đầu task | Task ngắn (≤ 5-6 round), cần độ chính xác cao, ít rủi ro vượt context window |
| `rolling_summary` | Chỉ `response_summary` đã tóm tắt cho **mọi round** | Task dài (nhiều round), ưu tiên tiết kiệm token, chấp nhận rủi ro mất chi tiết nhỏ |
| `hybrid` | Full nội dung cho N round gần nhất (VD 3 round), các round cũ hơn chỉ giữ `response_summary` | Mặc định khuyến nghị — cân bằng độ chính xác và chi phí, phù hợp chuỗi task nhiều bước như NF-137A → NF-137G |

### 4.3. Quy tắc vận hành

- `full_request_ref` / `full_response_ref`: Node lưu toàn văn request/response gốc ra file/DB riêng theo `task_id/round_N`, **không nhúng thẳng vào transcript** để tránh envelope phình to không kiểm soát — chỉ nhúng full content khi `conversation_mode` yêu cầu (full_transcript, hoặc N round gần nhất trong hybrid).
- Khi `conversation_mode = hybrid`, Node cần thêm cấu hình `hybrid_window` (VD `3`) quy định số round gần nhất giữ full — field này đặt trong `metadata`, không bắt buộc phải chuẩn hóa cứng trong schema.
- Nếu tổng token của `transcript[]` (ở mode `full_transcript` hoặc `hybrid`) vượt ngưỡng an toàn của context window, Node phải **tự động hạ cấp** round cũ nhất từ full → summary, ghi log việc hạ cấp này (không âm thầm cắt bỏ dữ liệu).
- `stable_context` (mục 3) và `transcript` (mục 4) là 2 khối **độc lập** — `cache_control` chỉ áp dụng cho `stable_context`, **không** áp dụng cho `transcript` vì nội dung này đổi mỗi round, cache sẽ luôn miss nếu gắn breakpoint vào đây.

## 5. Ảnh hưởng

- Cần cập nhật lớp build-request trong Forge orchestrator: chỗ ghép `system`/`messages` phải đọc `stable_context`/`dynamic_context` riêng thay vì gộp `context` như hiện tại, đồng thời đọc thêm `transcript[]` theo `conversation_mode`.
- Không ảnh hưởng ngược với các `task_type` khác — chỉ là tách lại field, giữ nguyên `changes[]`, `status`, `questions[]`.
- Cần bump `schema_version` lên `1.4` để phân biệt với schema cũ (tránh Node xử lý nhầm response cũ theo cấu trúc mới).
- Cần thêm cơ chế lưu trữ ngoài (`full_request_ref`/`full_response_ref`) — file hệ thống hoặc DB theo `task_id/round_N`, phục vụ cả `conversation_mode` lẫn audit/debug sau này.

## 6. Việc cần làm

- [ ] Cập nhật JSON Schema definition cho `stable_context`/`dynamic_context`.
- [ ] Sửa module build-request để chèn `cache_control` đúng vị trí breakpoint.
- [ ] Thêm log `cache_read_input_tokens` vào hệ thống monitor task hiện có.
- [ ] Viết test case: task 5 step liên tiếp, verify step 2-5 có `cache_read_input_tokens > 0`.
- [ ] Cập nhật tài liệu schema reference (23 schema hiện có) — đánh dấu schema nào áp dụng `cache_enabled`.
- [ ] Thêm field `conversation_mode` + `transcript[]` vào JSON Schema definition chính thức.
- [ ] Implement cơ chế lưu `full_request_ref`/`full_response_ref` ra file/DB theo `task_id/round_N`.
- [ ] Implement logic tự động hạ cấp round cũ (full → summary) khi vượt ngưỡng context window, kèm log.
- [ ] Viết test case cho từng `conversation_mode`: verify `full_transcript` gửi đủ, `rolling_summary` chỉ gửi tóm tắt, `hybrid` giữ đúng số round full theo `hybrid_window`.
- [ ] Cập nhật tài liệu để làm rõ: `conversation_mode` không tạo session/socket thật — vẫn là request/response độc lập theo từng round.

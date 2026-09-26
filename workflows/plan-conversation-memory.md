<!-- Architecture plan only. No runtime code, migration, tool registration, or tests have been implemented. -->
# Plan: Conversation memory runtime

**Trạng thái:** `PLANNED — CHƯA CODE`
**Phạm vi:** đặc tả runtime cho transcript, retrieval, checkpoint summary và forget trong workspace hiện tại. Đây là kế hoạch kiến trúc; không phải xác nhận đã triển khai.

## Mục tiêu và bất biến

- Transcript gốc là nguồn sự thật append-only. Summary chỉ là snapshot có provenance, không sửa hoặc thay transcript.
- Scope mặc định và ranh giới ủy quyền là `workspace_id`; không truy hồi chéo workspace nếu không có quyền rõ ràng.
- `memory.search` chỉ trả đoạn trích; `memory.get` chỉ mở rộng kết quả/range có kiểm soát, không dump lịch sử.
- Redaction áp dụng trước index, trước model và trước dữ liệu trả về. Không index secret dạng rõ.
- Forget phải xóa/ẩn cả dữ liệu dẫn xuất và để lại audit không chứa payload đã xóa.

## Data model và persistence — NF-MEM-001

Tạo logical tables/index:

- `memory_events`: transcript append-only.
- `memory_chunks`: text chunk đã redact cho FTS.
- `memory_summaries`: checkpoint/snapshot versioned cùng provenance.
- `memory_tombstones`: audit redact/purge và lý do, không có nội dung đã xóa.
- FTS lexical/BM25 index. Embedding/vector là giai đoạn sau MVP.

Mỗi event tối thiểu có `memory_id`, `workspace_id`, `project_id`, `conversation_id`, `sequence`, `role`, `content`, `created_at`, `source_event_id`, `content_hash`, `visibility`, và `redaction_state` (`clean`, `redacted`, `restricted`).

Yêu cầu migration: unique key `(workspace_id, conversation_id, sequence)`; `content_hash`/checksum để phát hiện thay đổi trái phép. Tool result được persist nhưng output lớn/binary không index toàn bộ; chỉ text đã redact được index.

## Retrieval — NF-MEM-002 và NF-MEM-003

### `memory.search`

Input gồm `query`, `workspace_id` bắt buộc và các filter tùy chọn: `project_id`, `conversation_id`, `roles`, khoảng thời gian, `limit`, `cursor`.

Luồng bắt buộc: authorize scope → redact → FTS/BM25 → rank → snippet giới hạn → cursor. Rank kết hợp lexical score, độ mới, ưu tiên user/assistant, và cùng conversation. Result luôn gồm `memory_id`, scope truy nguyên (`conversation_id`), `sequence`, `role`, `created_at`, `score`, `snippet`, `highlights`; gắn `source_type: transcript | summary` khi applicable.

Không trả event đã redact/forget theo policy hiển thị. Agent phải gọi `memory.search` trước khi suy đoán khi thiếu bối cảnh lịch sử.

### `memory.get`

Chỉ có hai mode: theo `memory_id` với `include_neighbors`, hoặc theo `conversation_id` và sequence range. Luôn kiểm tra `workspace_id`; giới hạn neighbor tối đa 5 mỗi phía và áp token/byte budget. Trả event gốc hoặc snapshot, không tự tổng hợp; sensitive content trả `redacted_content`.

Cursor phải ổn định theo `(created_at, sequence, memory_id)`. Không cho phép đọc event ngoài scope, đã xóa hoặc bị cấm hiển thị.

## Tool contract và agent policy — NF-MEM-004

Đăng ký schema cho `memory.search`, `memory.get`, `memory.summarize`, `memory.forget`; validate input, quyền workspace và budget tại runtime. Policy agent phải nêu rõ: search trước khi suy đoán, get chỉ để xác minh/mở rộng result, và không tự purge theo suy đoán.

## Checkpoint summary — NF-MEM-005

`memory.summarize` nhận `conversation_id`, `from_sequence`, `to_sequence`, `kind` (`checkpoint`, `decision`, `task_handoff`) và `force`. Chỉ chọn range chưa checkpoint hoặc checkpoint cần tạo lại; redact trước model.

Persist `summary_id`, `kind`, `content`, `source_range`, `source_memory_ids`, `created_at`, `model_metadata`, `status`. Nội dung phải có: quyết định, yêu cầu người dùng, trạng thái/việc dang dở, constraints, điểm cần xác minh. Mỗi claim quan trọng phải truy được về event nguồn. Index summary và transcript riêng nhãn; khi cần bằng chứng, agent dùng `memory.get` mở transcript. Forget nguồn phải invalidate hoặc regenerate summary phụ thuộc.

## Forget, quyền và audit — NF-MEM-006

- **Redact:** thay payload nhạy cảm bằng placeholder, giữ event ID/timestamp/audit trail.
- **Purge:** xóa payload gốc, chunks/FTS, embeddings, cache và summaries phụ thuộc; chỉ giữ tombstone tối thiểu nếu policy yêu cầu.

`memory.forget` nhận scope (`memory_ids`, hoặc conversation/project), `mode`, `reason`, và `confirmation_token` bắt buộc cho purge. Chỉ owner/admin hoặc retention worker được thao tác; purge cần token và authorization. Ghi tombstone với actor, lý do, thời gian, scope, số bản ghi ảnh hưởng. Hậu forget, search/get phải trả `not_found` và không tiết lộ event từng tồn tại. Retention worker phải idempotent.

## Thứ tự thực hiện và kiểm chứng

1. NF-MEM-001 — schema, persistence, redaction boundary.
2. NF-MEM-002 — FTS search và scope authorization.
3. NF-MEM-003 — get, neighbors, context budget.
4. NF-MEM-004 — tool registration, schema, agent policy.
5. NF-MEM-005 — summary checkpoint và provenance.
6. NF-MEM-006 — redact/purge, tombstone, cleanup.
7. NF-MEM-007 — E2E, security, retrieval-quality evaluation.
8. NF-MEM-008 — semantic/vector retrieval sau MVP; không chặn MVP.

E2E bắt buộc: quyết định A ở phiên 1; phiên 2 không có A trong context; agent search A, get result phù hợp, trả lời đúng và có thể trích `memory_id`; sau user forget A, search/get/summary/index không thể khôi phục A.

Acceptance tối thiểu: tìm keyword Việt/Anh; không search chéo workspace; result có ID, scope, timestamp; get được 2–5 turn liên quan; summary có provenance; forget loại bỏ dữ liệu khỏi transcript hiển thị, retrieval và dữ liệu dẫn xuất, đồng thời giữ audit an toàn.

## Rủi ro và quyết định cần xác nhận

- Xác định chính sách retention/tombstone, vai trò owner/admin, và cơ chế cấp confirmation token trước khi triển khai purge.
- Chốt database/FTS engine, giới hạn chunk/snippet/token/byte và policy redaction/secret detection.
- Vector retrieval chỉ được xem xét sau khi propagation scope, redaction và forget đạt kiểm chứng; embedding làm tăng rủi ro privacy nếu các boundary này chưa đúng.

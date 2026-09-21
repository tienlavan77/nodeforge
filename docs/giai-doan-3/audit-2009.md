<!-- Báo cáo audit retrieval, fallback và entrypoint của NodeForge. -->
# Audit 2009 — orphan, silent catch và eval bypass

Phạm vi: `backend/src`, `backend/tests/eval` và `backend/scripts`. Đây là audit read-only; không có mã nguồn nào được sửa trong ticket này.

## 1. Hàm mở rộng

| Hàm | File | Caller production | Kết quả |
|---|---|---|---|
| `connectWithLog` | `backend/src/transport/sse/conversation-stream.js:17` | `connect` trong cùng module: `:14` | Có caller, không orphan |
| `selectWithEmbeddings` | `backend/src/modules/index/relevant-tree.js:44` | `selectFreshWithEmbeddings:95`, tool production `backend/src/tools/select-code-graph-candidates.js:23` | Có caller, không orphan |
| `selectFreshWithEmbeddings` | `backend/src/modules/index/relevant-tree.js:95` | `backend/src/tools/select-code-graph-candidates.js:23` | Có caller, không orphan |
| `fetchWithRetry` | `backend/src/modules/agent/provider-adapters/codex-adapter.js:149` | Các request/poll production tại `:12`, `:38`, `:125` | Có caller, không orphan |
| `transitionWithoutGuard` | `backend/src/modules/projects/ticket-status-store.js:78` | `resetDoneForRetry:68`, `reconcile:75` | Có caller, không orphan |

Không phát hiện hàm có hậu tố `Extended`, `V2` hoặc `V3` bị orphan trong `backend/src`. Kết luận hiện tại: **0 orphan-function**.

## 2. Silent catch / fallback

Các vị trí dưới đây nuốt lỗi hoặc trả fallback mà không ghi log/warn tại block đó. “Nên log?” đánh giá dựa trên việc lỗi có làm giảm kết quả production hay chỉ là best-effort cleanup.

| File:line | Fallback | Nên log? | Loại | Rủi ro |
|---|---|---|---|---|
| `backend/src/modules/index/relevant-tree.js:36` | Trả `base` khi freshness check lỗi | Có, debug/warn có rate-limit | silent-catch | Cao — production retrieval có thể dùng index stale |
| `backend/src/modules/index/relevant-tree.js:89` | Trả lexical-only khi embedding merge lỗi | Có, warn | silent-catch | Cao — mất semantic retrieval mà không biết |
| `backend/src/modules/index/relevant-tree.js:114` | Trả base khi freshness semantic check lỗi | Có, debug/warn | silent-catch | Cao — ảnh hưởng context production |
| `backend/src/modules/index/relevant-tree.js:286` | `safeSearch` trả `[]` | Có, debug | silent-catch | Cao — mất candidate tier nhưng request vẫn thành công |
| `backend/src/modules/index/relevant-tree.js:290` | Graph lookup trả `[]` | Có, debug | silent-catch | Trung bình — mất graph expansion |
| `backend/src/modules/index/embedding-store.js:56` | Decode vector lỗi trả `null` | Có, warn khi checksum/model/vector lỗi | silent-catch | Cao — embedding hỏng bị loại âm thầm |
| `backend/src/modules/index/incremental-indexer.js:150` | Stat lỗi trả `null` | Có, debug nếu khác `ENOENT` | silent-catch | Trung bình — freshness/index metadata thiếu |
| `backend/src/modules/index/incremental-indexer.js:167` | Xóa embedding best-effort | Có, warn nếu cleanup lỗi | silent-catch | Trung bình — vector cũ có thể tồn tại |
| `backend/src/modules/projects/ticket-status-store.js:96` | Publisher lỗi không undo persistence | Nên log error | silent-catch | Cao — trạng thái đã lưu nhưng event downstream mất |
| `backend/src/modules/projects/ticket-status-store.js:97` | Observer lỗi không undo persistence | Nên log error | silent-catch | Trung bình — audit/stream có thể lệch |
| `backend/src/application/ticket-crud-service.js:172` | Publish event lỗi không undo mutation | Nên log error | silent-catch | Cao — mutation thành công nhưng stream mất |
| `backend/src/application/sprint-plan-upload-service.js:92` | Publish event lỗi không undo persistence | Nên log error | silent-catch | Cao — UI/downstream không biết thay đổi |
| `backend/src/infrastructure/git/git-service.js:145` | Audit hook lỗi không break Git | Nên log warn | silent-catch | Trung bình — mất audit trail |
| `backend/src/infrastructure/filesystem/file-service.js:24,29,34,80,208` | Promise queue/cleanup lỗi bị bỏ qua | Log lỗi cleanup; giữ im lặng cho queue bookkeeping chỉ nếu đã có owner | silent-catch | Trung bình |
| `backend/src/infrastructure/filesystem/file-service.js:57,124,144` | Cleanup temporary/handle lỗi bị bỏ qua hoặc lọc ENOENT | Log lỗi khác `ENOENT` | silent-catch | Thấp–trung bình |
| `backend/src/modules/index/incremental-indexer.js:213` | Async index task `.catch(() => {})` | Nên log error | silent-catch | Cao — index/embedding job có thể chết im lặng |

Các catch có trả error object, ném lại lỗi, hoặc đã gọi logger/debug không xếp vào silent-catch; ví dụ execution handlers, `owner-chat-service.safeLog`, bootstrap và watcher.

## 3. Registry / entrypoint audit

| File | Quan sát | Loại | Rủi ro |
|---|---|---|---|
| `backend/tests/eval/run-retrieval-eval.mjs:4-23` | Tự tạo `CodeSearch`, `FileGraph`, `RelevantTreeSelector`, `EmbeddingStore`, `OllamaEmbeddingProvider`; không đi qua `createForgeToolRegistry` | eval-bypass | Thấp — eval harness, nhưng có thể lệch wiring production |
| `backend/scripts/backfill-symbol-embeddings.mjs:8,31-32` | Tự tạo `EmbeddingStore` và Ollama provider | eval-bypass | Thấp — maintenance script, không phải request path |
| `backend/scripts/start-project-watcher.mjs:35-38` | Tự wiring embedding job/store/provider/indexer | eval-bypass | Cao — production watcher path; cần giữ tương đương bootstrap/production composition |
| `backend/scripts/control-api-platform.mjs:26-46` | Tự composition các service/index/retrieval dependency | eval-bypass | Cao — production control API composition; đây là entrypoint production tương đương, không phải tool bypass |
| `backend/scripts/test-search-code-tool.mjs:9-22` | Tạo dependency rồi đưa vào `createForgeToolRegistry` | Không lỗi | Thấp |
| `backend/scripts/test-read-code-tool.mjs:9-18` | Dùng `createForgeToolRegistry` | Không lỗi | Thấp |
| `backend/scripts/test-read-transcript-tool.mjs:9-22` | Dùng `createForgeToolRegistry` | Không lỗi | Thấp |
| `backend/scripts/test-select-code-graph-candidates-tool.mjs:10-23` | Dùng registry; selector là stub test | Không lỗi | Thấp |
| `backend/scripts/test-claude-sdk-tool-lab.mjs:15,77-87` | Dùng `createForgeToolRegistry` rồi tạo MCP server từ registry | Không lỗi | Thấp |

`backend/tests/eval/run-retrieval-eval.mjs` không phải production tool call; nó gọi selector trực tiếp để đo recall, nên được đánh dấu bypass về composition chứ không phải bug runtime. `control-api-platform.mjs` và `start-project-watcher.mjs` là các composition root hợp lệ; rủi ro chỉ là drift nếu wiring không được chia sẻ với bootstrap.

## Ưu tiên tạo ticket tiếp theo

1. **P0/P1:** thêm observability cho các fallback retrieval tại `relevant-tree.js`, đặc biệt embedding failure và `safeSearch`.
2. **P1:** log publisher/observer/indexer async failure để phát hiện trạng thái đã lưu nhưng event/index bị mất.
3. **P2:** chuẩn hóa composition dùng chung cho eval/backfill/watcher nếu cần bảo đảm cùng model, timeout và registry wiring.
4. **Không tạo ticket orphan-function:** audit hiện không tìm thấy orphan trong nhóm tên mở rộng đã rà.

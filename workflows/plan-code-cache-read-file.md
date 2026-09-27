# Kế hoạch Code Cache cho `read_file` / `read_code`

> **Trạng thái: PLANNED — chưa triển khai.**
>
> Đây là kế hoạch ticket triển khai, không phải mô tả code đã tồn tại. Cache nội dung nằm trong RAM của Control API; `search_code` có thể nạp trước các file kết quả trong giới hạn quota.

## 1. Phạm vi và quyết định bắt buộc

- Filesystem là source of truth; cache và Code Index/Graph là dữ liệu dẫn xuất.
- Cache nằm trong **Control API process**, không persist; API restart thì cache rỗng.
- Quota tổng: **20 MiB**, tính bằng `Buffer.byteLength(content, "utf8")`.
- TTL: **10 phút**, bắt đầu khi entry được chèn; hit/refresh không gia hạn TTL.
- Eviction: **FIFO theo lần chèn**, không phải LRU; hit không đổi thứ tự.
- File lớn hơn quota vẫn được đọc/trả về nhưng `cache.status = "bypass"`, không chiếm quota.
- Cache khi agent tìm thấy file qua `search_code` hoặc đọc file; watcher không tự prewarm file chưa được agent tìm/đọc.
- Không cache protected/secret/binary/invalid content theo policy hiện hữu.
- `cache.status` độc lập với `index_status` (`fresh | stale | unavailable`).
- Không chờ indexer, không rebuild index/graph trong read path.

## 2. Các điểm phải sửa so với bản kế hoạch cũ

1. Watcher và API là **hai process**; trao đổi qua `POST /forge/v1/stream/events` hiện có, không dùng chung `EventEmitter` hoặc map cache.
2. Không tạo endpoint nội bộ mới. Control API mở rộng xử lý event POST hiện có để refresh/invalidate cache; SSE chỉ phát cho UI.
3. Sau `search_code`, cache các file kết quả chưa có trong giới hạn quota, không gửi source content vào payload agent; lỗi nạp cache không chặn kết quả tìm kiếm.
4. Không coi `index_version` mẫu (`IDX-3`) là giá trị production. Metadata index phải lấy từ adapter hiện hữu và có provenance rõ ràng.
5. `read_file` hiện đọc trực tiếp `fileService.readForIndex`; `read_code` cũng vậy. Cả hai chưa được wiring với Code Cache Service.
6. Cache service không thể tự biết file đổi nếu watcher không báo. Khi có event nhưng refresh thất bại, phải invalidate để không phục vụ content cũ.

## 3. Contract thống nhất

### 3.1 Cache entry

Key là `(project_id, relative_path)`:

```js
{
  project_id, path, content, sha256, size_bytes,
  cached_at, expires_at, fifo_sequence
}
```

`sha256` là checksum toàn bộ content hiện tại. Entry hết hạn bị loại trước khi đọc; đọc lại tạo TTL/FIFO mới.

### 3.2 `read_file`

Đổi contract có chủ đích: `read_file({ path })` mặc định trả metadata file, symbol map và graph bounded, **không trả preview source**. Khi agent truyền `symbol` hoặc `offset`/`limit`, tool trả nội dung mã của vùng được chọn. Giữ checksum toàn file, kích thước, tổng số dòng, giới hạn 80 dòng mỗi lượt và `discovery_budget`. Cập nhật schema, mô tả tool và prompt cùng lúc để agent không lặp đọc metadata.

Bổ sung:

```json
{
  "cache": { "status": "hit|miss|bypass", "cached_at": "...", "expires_at": "..." },
  "code_index": {}, "code_graph": {},
  "content_sha256": "sha256:...",
  "indexed_sha256": "sha256:...",
  "index_version": "...",
  "index_status": "fresh|stale|unavailable"
}
```

- `fresh` khi có metadata và `indexed_sha256 === content_sha256`.
- `stale` khi có metadata nhưng checksum khác; chỉ trả content live khi agent yêu cầu vùng code và đánh dấu provenance cũ.
- `unavailable` khi không có row, index chưa sẵn sàng hoặc query lỗi; lỗi metadata không làm fail đọc file.
- Graph phải bounded và không chứa content file liên quan. Kích thước bound phải là hằng số/config được test.
- `search_code` cũng phải gắn freshness theo checksum hiện tại cho file trả về; không dùng symbol/line range cũ làm căn cứ đọc khi `stale`.
- Đọc theo `symbol` phải tìm lại symbol trên content hiện tại khi index `stale`; nếu không tìm được, báo rõ để agent tìm lại. Không tự trả preview hoặc dùng khoảng dòng cũ.
- Schema result strict hiện chưa có `read-file-result.schema.json`; ticket contract phải quyết định tạo schema này hoặc ghi rõ result không được validate bằng schema strict. Không được chỉ sửa response mà bỏ qua schema/generator.

### 3.3 `read_code`

Giữ nguyên authorization, exact `allowed_file_paths`, symbol allowlist, `kind`, `max_chars`, line range và retrieval budget. Chỉ thay nguồn content bằng Code Cache Service; bổ sung cache/index metadata nếu schema result được mở rộng. Symbol stale phải được kiểm tra lại trên content hiện tại; không trả mù line range cũ.

## 4. API của Code Cache Service

Tạo `backend/src/modules/context/code-cache-service.js`:

```js
createCodeCacheService({ projectId, fileService, indexMetadata, clock, limits })
service.read({ path })
service.refreshChanged({ path, expectedSha256 })
service.invalidate({ path })
service.stats()
service.close()
```

Yêu cầu:

- `read()` trả full content nội bộ, metadata cache và index best-effort; tool chỉ đưa source cho agent khi yêu cầu symbol/window.
- `refreshChanged()` chỉ hoạt động nếu entry đang tồn tại; đọc lại, xác minh checksum nếu watcher gửi checksum, cập nhật content/size/checksum nhưng giữ nguyên `cached_at`/`expires_at`.
- Nếu file đã bị xóa, checksum không khớp sau race, hoặc đọc lỗi: invalidate an toàn và trả trạng thái không phục vụ entry cũ.
- FIFO/quota/TTL phải được kiểm soát nhất quán trong process; không dùng timer cho từng entry nếu không cần, nhưng `read()` phải dọn entry hết hạn.
- `project_id` phải là scope bắt buộc; không chia sẻ entry giữa project khác nhau.
- Không ghi full content vào log.
- `indexMetadata` là read-only adapter; service không truy cập SQLite trực tiếp nếu kiến trúc hiện hữu yêu cầu qua service.

## 5. Watcher → API protocol

Dùng endpoint watcher đang POST tới Control API; **không tạo route mới**:

```text
POST /forge/v1/stream/events
```

Payload tối thiểu:

```json
{ "project_id": "...", "event_id": "EVT-...", "type": "watcher.file_modified", "timestamp": "...", "payload": { "path": "src/app.js", "operation": "change", "sha256": "sha256:..." }, "indexed": true }
```

Quy định bắt buộc:

- Giữ `projectStream.ingest(body)` cho stream; cùng event đó được chuyển tới cache handler trong Control API, không dùng SSE làm kênh mutation.
- Validate project, relative path, event, checksum và path policy trước khi tác động cache; từ chối path traversal/protected path. Event chỉ là tín hiệu: API tự đọc lại qua File Service, không tin source content từ POST.
- Request phải idempotent theo `(project_id, path, event, sha256)` hoặc event id.
- `changed/created`: chỉ refresh entry tồn tại; entry chưa có thì trả `not_cached`, không đọc file.
- `deleted`: invalidate entry; `renamed`: invalidate path cũ và chỉ refresh path mới nếu entry mới đã tồn tại.
- HTTP timeout/retry có giới hạn; watcher không bị block vô hạn và lỗi không làm dừng index pipeline.
- Chỉ ghi metric/log metadata: hit/miss/refresh/invalidate/error, không ghi content.

Watcher script đã POST event sau khi chạy indexer; ticket wiring chỉ bổ sung metadata cần cho cache và xử lý event ở Control API. Nếu không có checksum trong event, cache handler tự xác minh khi đọc lại file hoặc invalidate.

## 6. Wiring và write invalidation

- Composition root của Control API tạo cache service theo project/request lifecycle phù hợp với mô hình multi-project; phải chứng minh không tạo cache dùng nhầm project.
- Inject cùng service vào `search_code`, `read_file`, `read_code`, Claude `Read`/`Grep` và Codex `rg_search`/`sed_lines` ở nơi các tool đọc content. `Glob`/`rg_files` chỉ liệt kê đường dẫn.
- Inject invalidator vào `write_diff` và `edit_diff`; chỉ `invalidate(path)` **sau atomic write thành công**. Write thất bại không được làm mất entry hợp lệ.
- Cập nhật mọi registry/composition root: production runtime, owner tools và test harness liên quan.
- Giữ retrieval budget, repeat-read governance, checksum dùng cho `write_diff`/`edit_diff` và window tối đa 80 dòng; thay preview mặc định bằng metadata-only theo contract mới.
- Cập nhật tool/result schema và docs nếu thêm field; chạy `validate:schemas`.

## 7. Ticket triển khai

| Ticket | Nội dung | Phụ thuộc | Kết quả bắt buộc |
|---|---|---|---|
| NF-CACHE-001 | Contract/schema/freshness adapter | — | Schema field/enums, provenance checksum, bound graph, fixture fresh/stale/unavailable |
| NF-CACHE-002 | In-memory Code Cache Service | 001 | Unit test clock, bytes, FIFO nhiều entry, TTL, bypass, project isolation, close |
| NF-CACHE-003 | Wiring `search_code` và `read_file` | 002, 001 | Cache file kết quả có giới hạn; `read_file` mặc định metadata-only, symbol/window trả source hiện tại; freshness rõ ràng |
| NF-CACHE-004 | Wiring `read_code` | 002, 001 | File/symbol dùng cache, budget/allowlist giữ nguyên, stale symbol an toàn, schema pass |
| NF-CACHE-005 | Mở rộng watcher event POST hiện có | 002 | Dùng `/forge/v1/stream/events`, validate/idempotency, changed/deleted/renamed, không prewarm ngoài kết quả agent, giữ TTL |
| NF-CACHE-006 | Write invalidation + observability | 002, 003, 004 | Atomic write success mới invalidate, stats/log không lộ content, restart semantics |
| NF-CACHE-007 | Hai-process integration/E2E | 001–006 | API + watcher thật, race, index chậm, refresh checksum, delete, project isolation |

## 8. Acceptance criteria / test bắt buộc

- Đọc lần đầu là `miss`; đọc lại trước TTL là `hit` và không gọi filesystem lần hai.
- Sau TTL là miss và TTL mới; hit không đổi FIFO.
- Entry ≤20 MiB cache theo byte UTF-8; entry >20 MiB là `bypass`, không evict/chiếm quota.
- Cache đầy evict đúng FIFO, kể cả nhiều entry; entry khác project không bị ảnh hưởng.
- Watcher thay đổi chỉ refresh entry đã cache, giữ nguyên `cached_at`/`expires_at`; file chưa cache không bị đọc.
- Delete/rename không trả content cũ; API restart cache rỗng.
- Refresh checksum mismatch/race/read error không phục vụ entry stale.
- `fresh/stale/unavailable` đúng khi indexer chậm, checksum khác, không có row hoặc query lỗi; content vẫn đọc được khi metadata lỗi.
- `read_file({ path })` chỉ trả metadata; đọc theo symbol/window trả source hiện tại tối đa 80 dòng và checksum toàn file; `read_code` giữ scope, symbol allowlist và budget.
- Claude `Read`/`Grep` và Codex `rg_search`/`sed_lines` dùng cùng cache khi đọc content; `Glob`/`rg_files` không cache content.
- Protected/secret/binary không được cache; không có cross-project leakage.
- E2E: read miss → hit → watcher change → refresh/invalidate → content/checksum mới; index có thể stale trước khi fresh.
- E2E: approved symbol cũ nhưng content đã đổi không được trả mù line range; phải báo stale/không tìm thấy hoặc yêu cầu tra lại.
- Chạy tối thiểu: unit cache/tools, integration watcher/API, `pnpm lint`, `pnpm typecheck`, `pnpm validate:schemas`, test liên quan và `git diff --check`.

## 9. Không thuộc MVP

Disk cache/persistence/recovery, LRU, prewarm toàn repository, cache mọi watcher event, chờ indexer trước khi đọc, rebuild graph trong read path, hoặc trả full content của dependency/caller.

**Kết luận:** triển khai theo NF-CACHE-001 → 007; cache khi agent search hoặc đọc, watcher đồng bộ entry qua POST event hiện có, và index/graph luôn best-effort với trạng thái freshness minh bạch.

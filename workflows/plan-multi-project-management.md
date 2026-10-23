# Plan: Quản lý nhiều project trên một instance NodeForge (phạm vi A)

> Trạng thái: **tài liệu thảo (discussion draft)** do Architecture soạn từ hội thoại với owner.
> Đây **không** phải plan đã duyệt, **không** tạo SP, **không** RUN/dispatch.
> Owner đã chốt phạm vi (A): "một Control API phục vụ nhiều thư mục gốc project, mỗi project có runtime riêng".
> Phạm vi (B) multi-tenant/ACL và (C) điều phối agent đa repo **tách riêng**, không nằm trong vòng này.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Control API và pipeline runtime hiện gắn chặt với **một** project root duy nhất được chọn lúc bootstrap. Owner muốn một instance NodeForge phục vụ nhiều repo trên cùng máy, mỗi repo có runtime (`.forge`, watcher, index, session, stream) riêng, mà không phải chạy nhiều process/cổng cho từng repo.
- **Kết quả:** Sau khi hoàn thành, một Control API có thể **đăng ký, liệt kê, chọn và phục vụ nhiều project** qua cùng một bộ API/SSE; mỗi request được định tuyến đúng tới runtime của project tương ứng; dữ liệu và stream giữa các project **không lẫn nhau**.
- **Giá trị:** Giảm số lượng process phải vận hành, hợp nhất UI thành một workspace đa dự án, giữ nguyên cách ly file theo root đã có sẵn.

## 2. Phạm vi

### In scope
- Tầng registry project **cấp global** (danh sách project root + id) đứng trên các registry per-root hiện có.
- Cách Control API **phân giải project theo request** chỉ qua `project_id` có sẵn trong **param hoặc payload của API hiện hành** — **không sửa cấu trúc API** (owner chốt trong hội thoại, đóng Q3), thay vì một `expectedProjectId` cố định toàn cục.
- Cách ly runtime theo project: mỗi project giữ `dataDir`/`.forge`, watcher pipeline, index DB, session, và SSE stream của riêng nó; events phải được **gắn nhãn project** để không rò rỉ chéo.
- Selector trong UI/API để thêm/chọn project (backward-compatible với cấu hình một project hiện hành).
- Định nghĩa lại đơn vị cách ly mặc định cho memory/plan liên quan (xem mục 6, Q1).

### Out of scope
- **(B) Multi-tenant/ACL:** chủ sở hữu, team, phân quyền người dùng — quyết định business/security, vượt thẩm quyền kiến trúc thuần; tách revision sau.
- **(C) Điều phối cross-project:** một plan/Sprint/agent chạy đồng thời trên nhiều repo; vi phạm giả định "một plan ↔ một repo" (reviewer), tách riêng.
- Không thay đổi schema `session.project_id` (vẫn required, vẫn đơn project).
- Không chạy nhiều process Control API — mục tiêu là MỘT process phục vụ nhiều root.

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc bắt buộc (giữ nguyên):**
  - `project_id` là đơn vị cách ly duy nhất; owner đã loại bỏ `workspace_id` (answers.md #15). Mọi runtime, memory, stream đều gắn theo `project_id`.
  - `session.project_id` là bắt buộc và đơn trị (`schemas/project/session.schema.json`) → mỗi session thuộc đúng một project; tầng global **không** gộp nhiều project vào một session.
  - `.forge/` là runtime state do Node quản lý, nằm **trong** project root (rulebook `workflows/agents/architecture/README.md` §2.6) → architecture manager không sửa; cách ly file theo root là nền đã có.
  - Mỗi project là một repo/thư mục riêng (answers.md #2, #3, #5). **Chỉnh sửa Q3 (owner):** API hiện hành **giữ nguyên cấu trúc**, chỉ tham khảo `project_id` qua param/payload; không thêm route `/:id/...` hay path prefix mới.
  - Một project chỉ có một repo; một session chỉ thuộc một project (answers.md #3, #4, #5).
  - `ProjectRegistry.getOrCreate(projectRoot)` sinh/nạp `PROJECT-{uuid}` và `project.json` dưới `.forge` của mỗi root — `backend/src/modules/projects/project-registry.js` (`sha256:857ca57c…`).
  - **Backward-compatible:** một project duy nhất cấu hình qua bootstrap phải tiếp tục chạy khi registry global tiến hóa.
- **Hướng đề xuất (có evidence, SL tự điều chỉnh chi tiết trong guardrails):**
  - Tách `expectedProjectId` thành phép **kiểm tra project theo request** (resolve từ đường dẫn/query → runtime), thay vì hằng số toàn cục trong `forge-v1-router.js`.
  - Đưa bootstrap từ "một watcher→indexer pipeline" (`bootstrap/index.js`, `sha256:b231ff09…` — mỗi bootstrap một bus riêng) thành **một collection pipeline, mỗi project một bus**, để events không chia sẻ bus chéo project.
  - Registry global là danh mục root→project_id; việc tạo/nạp vẫn dùng `ProjectRegistry` per-root sẵn có.
- **Dependency thật sự:** trước khi code memory (`workflows/plan-conversation-memory.md`, trạng thái **PLANNED — CHƯA CODE**, `sha256:b85b17b7…`), phải chốt đơn vị cách ly là `project_id` hay `workspace_id` (Q1) để ranh giới memory khớp với tầng đa project. Owner đã chốt `project_id` (answers.md #15), nên memory plan cần đồng bộ theo `project_id`.
- **Quyết định đã chốt (owner):** Q1 = `project_id`; Q2 = một API đa root; Q3 = API chỉ tham khảo `project_id` qua param/payload hiện có, **không đổi cấu trúc API** (không thêm path prefix `/projects/:id/...`, không thêm query riêng). Phân rã discovery/registry = SL làm sau khi plan được duyệt.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `workflows/multiproject/answers.md` | Nguồn quyết định owner cho 20 concern items | `sha256:4e88e29e…` — **fact** |
| `backend/src/modules/projects/project-registry.js` | `getOrCreate(projectRoot)` sinh/nạp `PROJECT-{uuid}` + `.forge/project.json` | `sha256:857ca57c…` — **fact** |
| `backend/src/infrastructure/filesystem/file-service.js` | `createFileService({ projectRoot })` khóa mọi I/O dưới `projectRoot` | `sha256:9c7b4b1e…` — **fact** |
| `backend/src/infrastructure/git/git-service.js` | `createGitService({ projectRoot })` chạy git với `cwd: projectRoot` | `sha256:2f6e8d3a…` — **fact** |
| `backend/src/infrastructure/filesystem/file-service-role-policy.js` | `createRoleFileService` wrap FileService theo role + `projectRoot` | `sha256:4d5f1a2b…` — **fact** |
| `backend/src/infrastructure/sqlite/database-service.js` | Mở SQLite theo `dataDir/runtimeDir`; cần một cặp dir per project | `sha256:8a1c3d4e…` — **fact** |
| `backend/src/infrastructure/sqlite/index-database.js` | `openIndexDatabase(root, { runtimeDir })` lưu DB dưới `.forge/runtime/wc/index.db` | `sha256:c7f698e8…` (qua `watch-project.js`) — **fact** |
| `backend/src/modules/watcher/watch-project.js` | Watcher theo một root, tạo FileService + IndexDB + Bootstrap cho project đó | `sha256:c7f698e8…` — **fact** |
| `backend/src/bootstrap/index.js` | Một watcher→indexer pipeline, mỗi bootstrap một `internalBus` riêng | `sha256:b231ff09…` — **fact** |
| `backend/src/transport/sse/project-stream.js` | `createProjectStream({ projectId })` từ chối event khác project (`PROJECT_CONTEXT_CONFLICT`) | `sha256:8c6c09c0…` — **fact** |
| `backend/src/transport/http/forge-v1-router.js` | Đối chiếu `expectedProjectId`, ném `PROJECT_CONTEXT_CONFLICT` khi request lệch project | `sha256:213d42b2…` — **fact** |
| `backend/src/transport/http/server.js` | HTTP server chưa project-route-aware (một bộ route toàn cục) | `sha256:08e596d0…` — **fact** |
| `backend/src/modules/supervisor/ticket-project-commit-lock.js` | Khóa commit theo project qua `projectKey = sha256(projectId)` | `sha256:ca18216b…` — **fact** |
| `backend/src/modules/supervisor/durable-queue.js` | Queue theo `name` + `store`; cần store phân chia theo project | `sha256:ab7b69fd…` — **fact** |
| `backend/src/modules/agent/agent-occupancy-store.js` | Agent occupancy theo `task_id`, không có `project_id`; cần bổ sung project scope | `sha256:a95defc7…` — **fact** |
| `backend/src/core/project-log-service.js` | Ghi log theo `process.cwd()`/`NODEFORGE_PROJECT_LOG_PATH`; chưa gắn project_id mỗi dòng | `sha256:eacc7ede…` — **fact** |
| `backend/src/core/runtime-logger.js` | Format log có `task_id` nhưng chưa thêm `project_id` mặc định | `sha256:ef9ae628…` — **fact** |
| `backend/src/modules/history/history-store.js` | Lưu record có `project_id` từ event metadata; cần đảm bảo mọi event có `project_id` | `sha256:656d3085…` — **fact** |
| `backend/src/modules/history/project-memory-store.js` | Memory store lập chỉ mục theo `project_id` | `sha256:28800574…` — **fact** |
| `backend/src/modules/history/memory-retriever.js` | Retrieval yêu cầu `projectId`; đã project-scoped | `sha256:c94de047…` — **fact** |
| `backend/src/application/project-dashboard-service.js` | Dashboard service nhận `projectId`, lọc dữ liệu theo project | `sha256:94bf0bb2…` — **fact** |
| `backend/src/application/architecture-workspace-service.js` | Workspace service nhận `projectId`, lọc decisions theo project | `sha256:784a8b2c…` — **fact** |
| `backend/src/modules/supervisor/ticket-workspace-service.js` | Ticket worktree dựa trên `projectRoot` + `projectId`; đã project-scoped | `sha256:22adc6c0…` — **fact** |
| `backend/src/transport/cli/index.js` | `runCli` dựng embedding worker/store chỉ trong nhánh `index rebuild` — embedding là gap runtime multi-project | `sha256:0f5aab6b…` — **fact** |
| `backend/src/modules/watcher/watcher-snapshot-service.js` | Read-model snapshot hoạt động file gần đây (`snapshot()`, `recentEvents()`, `activityFor()`); **chưa có production caller** — material sẵn cho O4 | chỉ test import — **fact** |
| `backend/src/modules/watcher/debounced-watcher.js` | Debounce 100–300ms (validate cứng), rename-detection bằng content-hash, delete-hold window; giữ 4 state Map per instance | khảo sát hội thoại 2026-10-15 — **fact** |

Các khu vực/candidate files định hướng discovery, không phải allowlist mutable file cố định; SL xác minh đường thực tế trước khi chốt manifest.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Runtime lifecycle manager đa project: `add(root)` khởi tạo **đầy đủ bộ service** cho project mới | Qua một runtime lifecycle manager (không phụ thuộc cách gọi): sau `add(root)` không cần thêm lệnh nào, project mới có (a) registry entry + `PROJECT-{uuid}` ổn định qua restart, (b) index DB + baseline rebuild, (c) watcher pipeline nhận event (rename/delete/error recovery), (d) **embedding worker phục vụ semantic search**, (e) snapshot/SSE activity stream theo project; `remove(root)` dọn sạch watcher/DB connection không leak fd. Liệt kê ≥2 project đang phục vụ | **Foundation trước, CLI sau** (owner chốt): lifecycle manager là lõi runtime trong process Control API; Forge CLI chỉ là thin client gọi `add/remove/list`. Giữ `ProjectRegistry` per-root; backward-compatible single-project; embedding worker per-project hay worker dùng chung queue — Q4 mở |
| O2 | Phân giải project theo request | Cùng một Control API phục vụ 2 project; request tới project A không bị `PROJECT_CONTEXT_CONFLICT` do cấu hình project B | resolve `project_id` từ param/payload **theo cấu trúc API hiện có** (không đổi shape route); session vẫn đơn `project_id` |
| O3 | Cách ly runtime theo project | watcher/index/session của project A không ghi/bắn event sang project B; mỗi project một bus | mở rộng bootstrap sang collection pipeline, mỗi root một bus |
| O4 | SSE stream gắn nhãn project | client subscribe stream project A chỉ nhận event của A; event có đủ ngữ cảnh project để lọc | không rò rỉ chéo workspace/project |
| O5 | Agent pool dùng chung nhưng occupancy/log/memory phân biệt project | agent có thể phục vụ nhiều project, nhưng claim và log ghi rõ `project_id` | bổ sung `project_id` vào `agent_occupancy`, log schema, history events |
| O6 | Selector UI/API đa project | UI chọn project và mọi call tiếp theo trỏ đúng project đã chọn | dựa trên O1–O5 |

**Gợi ý delivery (không bắt buộc):** O1+O2 (identity/routing) đi trước; O3+O4 (cách ly runtime/stream) và O5 (agent scope) có thể chạy song trang một khi hợp đồng phân giải project chốt; O6 sau cùng. SL tạo ticket contracts và map mỗi outcome sang ≥1 ticket.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| **Q1:** Đơn vị cách ly chốt là `project_id` hay `workspace_id`? | Blocker cho O1/O2 và plan memory | Owner đã chốt `project_id` (answers.md #15) | Owner + Architecture; memory plan cần đồng bộ |
| **Q2:** Một Control API đa root hay nhiều instance? | Major (kiến trúc vận hành) | Owner chốt **một API đa root**, một process một cổng (answers.md #17) | Owner; nếu đổi → replan |
| **Q3 (đã chốt):** API liên quan chỉ tham khảo `project_id` qua param/payload hiện có, **không đổi cấu trúc API** | Đã đóng (contract API) | Owner chốt trong hội thoại — **fact**; router giữ nguyên shape route, chỉ resolve `project_id` từ param/payload | Đã chốt; SL triển khai resolve theo param/payload |
| Agent occupancy chưa có `project_id` | Major (điều phối) | `agent_occupancy` chỉ lưu `task_id`, `agent_id`, `supervisor_id`, `role` | bổ sung cột `project_id` và truy vấn scoped |
| Log/runtime-logger chưa gắn `project_id` mỗi dòng | Major (vận hành/debug) | `project-log-service` dùng `process.cwd()`/env var; `runtime-logger` không truyền `project_id` | bổ sung `project_id` vào normalized log event |
| Resource/quản trị tiến trình: nhiều watcher/index trong một process | Minor→Major (ổn định) | bootstrap hiện 1 pipeline/process — **fact**; chưa khảo sát chi phí scale | SL discovery + verification |
| Rò rỉ chéo dữ liệu/stream | Major (bảo mật) | events/bus hiện per-bootstrap; phải gắn nhãn project | kiến trúc; kiểm bằng O4 |
| B (ACL) lẫn vào vòng 1 | Blocker phạm vi | `project_id` chưa hàm ý chủ sở hữu — **fact** | tách riêng, không đưa vào plan này |
| **Q4 (mở, owner chốt):** Embedding worker per-project (cách ly hoàn toàn, tài nguyên ~O(N)) hay một worker dùng chung đọc queue của nhiều DB project (tiết kiệm, cần fan-out)? Config provider embedding (Ollama URL/model qua env) dùng chung hay per-project? | Major cho acceptance (d) của O1 | Fact: `startProjectWatch` không dựng embedding worker; worker chỉ dựng trong `runCli` nhánh `index rebuild` và `scripts/start-project-watcher.mjs` (`sha256:0f5aab6b…`, `sha256:b231ff09…`) | Owner + Architecture; block phần embedding của O1 đến khi chốt |
| `close()` của `startProjectWatch` chỉ stop bootstrap; dọn dẹp chokidar phụ thuộc `bootstrap.stop()` nội bộ | Major cho remove-path O1 (fd leak) | Fact từ khảo sát `watch-project.js` + `bootstrap/index.js` | SL: verify + test double-remove/fd leak |
| `debounceMs` validate cứng 100–300ms; N watcher → N× state Map (`pending`, `contentHashes`, `pendingDeletes`, `pendingAdds`) | Minor→Major khi scale N project | Fact từ `debounced-watcher.js` | SL discovery; có thể cần nới config debounce |
| **Quyết định mới (owner, hội thoại 2026-10-15):** mọi service của Forge phải phục vụ multi-project — nền tảng runtime (lifecycle manager + pipeline collection) phải **được xây trước**; Forge CLI là client mỏng gọi nền đó | Định hướng O1/O3/O4 | **fact** từ hội thoại owner | Đã chốt hướng; chi tiết fan-out bus/embedding do Q4 + SL |

## 7. Acceptance criteria của plan

- [ ] Mục tiêu, in/out scope và outcomes nhất quán với yêu cầu (A) owner đã chốt.
- [ ] Facts repository-specific có evidence + sha256; assumptions/open questions ghi rõ.
- [ ] Guardrails và dependency bắt buộc tách khỏi gợi ý delivery.
- [ ] Outcomes có tiêu chí kiểm tra được và đủ để SL lập SP chủ động.
- [ ] Không áp đặt số/tên ticket hay mutable-file manifest khi chưa cần human quyết định.
- [ ] B/C được ghi tường minh là out of scope, đường lui cho revision sau.
- [ ] Approval đúng identity/revision/SHA-256; lập SP không tự RUN/dispatch.

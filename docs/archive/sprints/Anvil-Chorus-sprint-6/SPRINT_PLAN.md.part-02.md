<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
| agents | `project` | spawn, stop, cancel, observe | không cấp |
| events | `project` | publish, subscribe | publish, subscribe — **chỉ phạm vi event tầng Agent Protocol** (lifecycle/log của chính agent đó); AI không được publish event hệ thống (`watcher.*`, `index.*`, `workflow.*`...) vì các event đó phải phản ánh trạng thái Node quan sát thật, không phải do AI tự khai báo |

`forge_runtime` là nhãn capability, không phải ACL path — quyền path thật cho `.forge/**` vẫn do
`permission.schema.json` quyết định (Node read/write toàn bộ; AI mặc định deny write, chỉ read
hạn chế, khớp ARCHITECTURE.md mục 5–6).

**Cách khóa schema:**
- Xóa `capabilities: string[]` khỏi `core/agent.schema.json`.
- Bắt buộc `capability_scopes`.
- `core/agent.schema.json` chứa 2 profile vocabulary qua điều kiện `type: system + role: orchestrator`
  (Node) và `type: ai` (AI).
- `node-agent.schema.json` (nếu tồn tại) chuyển sang `allOf` tham chiếu core, chỉ thêm
  trạng thái/version riêng của Node.
- Deprecate/xóa `node-capability.schema.json` — nguồn vocabulary thứ hai không còn cần thiết.

#### Pre-work: danh sách nháp `type` cho NF-005/NF-006 (Builder review lại khi build Sprint 1+)

Rà theo từng module `STRUCTURE.md` + Context Broker (mục 14 ARCHITECTURE.md). Đây là bản nháp
tối thiểu — chưa chắc đủ, Builder bổ sung khi thấy thiếu lúc code module thật.

**Event `type` (theo module phát ra):**

| Module | Event nháp |
|---|---|
| watcher | `file.created`, `file.modified`, `file.deleted`, `file.renamed` (rename+move gộp chung — quyết định NF-016/NF-027, xem Sprint 1) |
| index | `index.file_indexed`, `index.file_removed`, `index.rebuilt`, `index.inconsistent` |
| git | `git.diff_generated`, `git.changeset_created` |
| verification | `verification.test_completed`, `verification.check_completed` (kind: build/lint/typecheck) |
| context | `context.pack_generated`, `context.cache_invalidated` |
| rules | `rule.violated`, `permission.denied` |
| workflows | `workflow.state_transitioned`, `workflow.started`, `workflow.completed` |
| agents | `agent.started`, `agent.stopped`, `agent.message_received`, `agent.error` |
| projects | `project.opened`, `project.closed` |
| history | `history.summary_created` |

**Command `type` (theo mục 14 ARCHITECTURE — Agent yêu cầu Context Broker, + workflow):**

| Nhóm | Command nháp |
|---|---|
| Context request (Agent → Node) | `READ_FILE`, `READ_SYMBOL`, `READ_RANGE`, `SEARCH`, `GET_CALLERS`, `GET_DEFINITION`, `GET_IMPORTS`, `GET_DIFF`, `GET_TESTS` |
| Verification (Node thực thi) | `run_test`, `run_check` (kind: build/lint/typecheck) |
| Workflow | `transition_state`, `assign_task` |
| Index | `rebuild_index` (tương ứng `forge index rebuild`, mục 13 ARCHITECTURE) |

**Lưu ý khi Builder khóa enum:** mỗi Event/Command nên có tiền tố theo domain (`watcher.*`,
`index.*`, `workflow.*`...) để dễ audit trong Event Store — chưa thấy quy ước này được nêu rõ
trong tài liệu gốc, đề xuất Builder áp dụng thống nhất rồi báo lại để mình duyệt cùng lúc với
schema.

---

## Sprint 1 — Filesystem Watcher + Code Index

> **Đã review bởi sprint leader:** 3 quyết định thiết kế bên dưới đối chiếu từng mục với
> `ARCHITECTURE.md` (mục 7/9/10/11/12/13/53) — duyệt cả 3. Riêng PHP extractor (quyết định
> #3) được xác nhận có căn cứ thực tế (project mục tiêu là PHP+JS), giữ nguyên trong Sprint 1.
>
> **✅ Sprint 1 ĐÓNG (qua NF-027):** toàn bộ 14 ticket (NF-014→027, gồm NF-021b phát sinh)
> Done. 3 điểm treo ở lần review trước (polling NF-014, gộp `file.renamed`/`file.moved`
> NF-016, chọn `node:sqlite` experimental NF-017) đã được Builder giải trình cụ thể, có bằng
> chứng kiểm chứng được — không phải trả lời chung chung. Chi tiết từng điểm xem trực tiếp ở
> dòng ticket tương ứng trong bảng backlog.

**Mục tiêu:** đây là nền tảng của toàn bộ Forge — không có watcher/index thì Context Engine,
Workflow, Reviewer đều không có dữ liệu. Không có Agent/AI tham gia ở sprint này — thuần kỹ
thuật, rủi ro thấp, nên làm sớm (đúng lý do đã nêu ở mục "Vì sao thứ tự sprint lệch mục 58"
phía trên).

### Ba quyết định thiết kế phải chốt trước khi giao ticket

**1. `.forge/` ở Sprint 1 là bản tối thiểu, chưa phải bản chính thức.** Việc tạo `.forge/`
đầy đủ (`schemas/ rules/ workflows/ runtime/`, theo ARCHITECTURE.md mục 53) là việc của
**Sprint 2**. Nhưng Sprint 1 cần `.forge/index.db` chạy được ngay để test integration.
Sprint 1 chỉ implement `ensureRuntimeDir(projectRoot)` trong `src/infrastructure/filesystem/`
— tạo đúng `.forge/runtime/`, đủ chỗ cho `index.db`. Sprint 2 mở rộng thành layout đầy đủ,
tái dùng lại hàm này chứ không viết lại.

**2. Watcher → Index nối qua `EventEmitter` nội bộ, KHÔNG phải Event Store.**
`src/modules/events/` (publication, idempotency, subscriptions — Event Store thật) là
**Sprint 7**. Sprint 1 dùng `node:events` `EventEmitter` thuần, private trong composition
root (`src/bootstrap/`), chỉ để nối nội bộ watcher → indexer trong cùng process
(`internalBus`) — không expose ra ngoài, không persist, không idempotency key. Payload vẫn
đúng field tối thiểu mà `core/event.schema.json` (NF-005) đã định nghĩa cho `file.*`/
`index.*`, để khi Sprint 7 thay `internalBus` bằng Event Store thật, payload không phải đổi
shape.

**3. Phạm vi ngôn ngữ được index: JS/TS + PHP, qua extractor pluggable.** Vì danh sách
ngôn ngữ chắc chắn còn mở rộng, indexer core gọi qua một **extractor interface chung**
thay vì hard-code 1 parser — chọn extractor theo phần mở rộng file:

```
src/modules/index/parser/
├── index.js       # registry: extension → extractor, indexer core chỉ gọi qua đây
├── javascript.js   # .js .jsx .mjs .cjs .ts .tsx — @babel/parser
└── php.js          # .php — php-parser (glayzzle/php-parser, pure JS)
```

Mọi extractor trả cùng 1 shape chuẩn hoá (indexer core không biết chi tiết AST từng ngôn ngữ):

```json
{
  "symbols": [{ "kind": "function|class|method|interface|trait", "name": "...", "line_start": 0, "line_end": 0 }],
  "imports": [{ "specifier": "...", "kind": "import|require|use|include", "external": true }],
  "exports": [{ "name": "...", "kind": "..." }]
}
```

File ngôn ngữ chưa có extractor: watcher vẫn thấy event, index chỉ lưu `files` row (path,
file_id, hash, mtime), không có `symbols`.

**Lưu ý riêng cho PHP (khác JS khá nhiều):**
- Không có `import`/`export` kiểu ES module — tương đương gần nhất là `use` (namespace
  import) và `require`/`require_once`/`include`/`include_once` (file include).
- Resolve `use App\Services\Auth;` thành `file_id` cụ thể phụ thuộc PSR-4 autoload map
  trong `composer.json` — **chưa làm ở Sprint 1**. Chỉ resolve được `require`/`include`
  dạng đường dẫn tương đối rõ ràng; `use` namespace mặc định ghi `external: true`. Resolve
  PSR-4 đầy đủ để sau, là ticket riêng cho sprint sau nếu cần.
- Symbol PHP có thêm `interface` và `trait` (JS không có) — extractor PHP trả `kind` tương
  ứng, indexer core coi như symbol bình thường.

### Bảng phụ thuộc trong-sprint

```
NF-001 (đã Done, Sprint 0)
   │
   ├─▶ NF-014 (watcher adapter thô + ignore)
   │        │
   │        ▼
   │      NF-015 (debounce/stability)
   │        │
   │        ▼
   │      NF-016 (rename/move heuristic)
   │
   ├─▶ NF-017 (SQLite schema + adapter) ──▶ NF-018 (file_id integration)
   │                                              │
   ├─▶ NF-019 (extractor interface + JS/TS extractor) ┐
   │        │                                          │
   ├─▶ NF-019b (PHP extractor, song song NF-019)        │
   │        │                                          │
   │        ▼                                          ▼
   │      NF-020 (incremental indexer) ◀────────────────┘
   │        │
   │        ▼
   │      NF-021 (dependency graph)
   │        │
   │        ▼
   │      NF-022 (rebuild command + consistency check)
   │
   └─▶ NF-023 (internal bus wiring watcher→index) ── cần NF-015 + NF-016 + NF-020
            │
            ▼
          NF-024, NF-025, NF-026 (integration/stress test)
            │
            ▼
          NF-027 (exit check Sprint 1)
```

Có thể chạy song song: `NF-014→016` (watcher), `NF-017→019/019b` (storage + parser) là các
nhánh độc lập cho tới khi gặp nhau ở NF-020.

### Backlog

| ID | Ticket | Thư mục | Phụ thuộc | Est. | Acceptance criteria | Trạng thái |
|---|---|---|---|---|---|---|
| NF-014 | Watcher adapter thô (chokidar): bắt raw `add/change/unlink`; ignore mặc định `.forge/**`, `node_modules/**`, `.git/**`, `dist/**`, `coverage/**` (mục 7) + cho phép project override qua config | `src/infrastructure/filesystem/` | NF-001 | M | Sửa file trong `src/` → nhận raw event; sửa file trong `node_modules/` hoặc `.forge/` → không nhận event nào | ✅ Done — root cause: chokidar v4 dùng path tuyệt đối, glob ignore không match; sửa bằng picomatch trên path tương đối. 3/3 test xanh. **Ghi chú polling đã giải trình (NF-027):** `usePolling: true` chỉ đặt trong test watcher/integration để tránh giới hạn handle/native watcher; adapter production không set, không có env var bật — không lọt vào production |
| NF-015 | Debounce + file-stability: gom nhiều `change` liên tiếp thành 1 event sau khi file ổn định 100–300ms (config được, mục 9); chuẩn hoá raw event → `file.created/file.modified/file.deleted` khớp enum NF-005/NF-008 | `src/modules/watcher/` | NF-014, NF-008 | M | Ghi file 5 lần liên tiếp trong 50ms → chỉ 1 `file.modified` được phát; event object validate được qua `node-event.schema.json` | ✅ Done — mặc định 200ms, config 100–300ms, validate bằng Ajv trước khi emit, 14/14 test xanh |
| NF-016 | Rename/Move heuristic: chokidar không có event "rename" gốc — phát hiện `unlink`+`add` cùng content-hash trong cửa sổ thời gian ngắn (config, mặc định ~500ms) → gộp thành **`file.renamed` (quyết định cuối, mục NF-027: rename và move đều chỉ là đổi path của cùng `file_id`, Context/Index không cần phân biệt — không còn `file.moved` riêng, đã đồng bộ `schemas/core/event.schema.json` + `schemas/node/node-event.schema.json`)** thay vì delete+create | `src/modules/watcher/` | NF-015 | M | `mv src/auth.js src/security/auth.js` → phát đúng 1 `file.renamed` (không phải 1 `file.deleted` + 1 `file.created`); di chuyển ra ngoài project hoặc đổi nội dung đồng thời → xử lý như delete+create | ✅ Done — SHA-256 + cửa sổ 500ms (config được), payload có `old_path`. Quyết định gộp `file.renamed`/`file.moved` thành 1 event là **có chủ đích**, không phải thiếu sót — xác nhận ở NF-027 |
| NF-017 | SQLite schema + adapter cho `.forge/runtime/index.db`: bảng `files`, `symbols`, `imports_exports`, `calls`, `references`, `tests_map`, `dependency_edges`; migration script | `src/infrastructure/sqlite/` | NF-001 | M | `ensureRuntimeDir()` tạo `.forge/runtime/`; mở `index.db` lần đầu tự chạy migration; mở lại lần 2 không lỗi (idempotent) | ✅ Done — dùng `node:sqlite` (`DatabaseSync`), ghi trực tiếp SQLite thật; `engines.node >=22.5.0`. **Quyết định cuối (NF-027):** giữ `node:sqlite`, không chuyển `better-sqlite3` trước Sprint 2 — chấp nhận rủi ro `ExperimentalWarning` (xác nhận trên Node v24.13.0), cần theo dõi khi Node stabilize API |
| NF-018 | Tích hợp `file_id` (từ NF-010 `file-identity.js`) vào bảng `files`: `file_id` là khoá chính ổn định, `path` chỉ là cột thường có thể update | `src/infrastructure/sqlite/`, `src/modules/index/` | NF-010, NF-017 | S | Insert file → có `file_id`; update `path` của row hiện có (giả lập rename) → `file_id` không đổi | ✅ Done — `file-repository.js`, `insert()`/`rename()` tách biệt path khỏi identity, 13/13 test xanh |
| NF-019 | Extractor registry (`parser/index.js`, chọn extractor theo phần mở rộng file, trả shape chuẩn hoá `symbols/imports/exports`) + JS/TS extractor bằng `@babel/parser`: trích `function/class/method` (tên + line range), `import`/`export` statement | `src/modules/index/parser/` | NF-001 | M | File có 3 function → trích đúng 3 symbol với line range đúng; file không có extractor đăng ký (vd `.py`) → registry trả rỗng, không throw | ✅ Done — `contract.js` chốt shape chung; `external` bổ sung sau ở NF-019b, JS/TS test đã cập nhật assertion |
| NF-019b | PHP extractor bằng `php-parser` (glayzzle/php-parser): trích `function/class/method/interface/trait` (tên + line range); `use` namespace → `imports` với `kind: use, external: true`; `require`/`require_once`/`include`/`include_once` đường dẫn tương đối → `imports` với `kind: require, external: false`, dạng biến/biểu thức động → bỏ qua | `src/modules/index/parser/` | NF-001 (song song NF-019) | M | File PHP có class + 2 method → trích đúng symbol + line range; `require_once __DIR__.'/auth.php'` → resolve ra path đúng; `use App\Services\Auth;` → ghi nhận `external: true`, không throw dù chưa có composer autoload map | ✅ Done — `external` chốt trong `contract.js`, JS/TS đồng bộ theo (package = external, relative = không); require động + external JS đều có test riêng. 12/12 test xanh |
| NF-020 | Incremental indexer core: gọi extractor registry theo phần mở rộng file, không biết chi tiết ngôn ngữ; `MODIFY` → re-index 1 file; `CREATE` → insert mới; `DELETE` → xoá row + đánh dấu quan hệ phụ thuộc bị đứt; `RENAME/MOVE` → chỉ update `path`, giữ nguyên `file_id` và mọi quan hệ (mục 11) | `src/modules/index/` | NF-017, NF-018, NF-019, NF-019b | L | 4 trường hợp CREATE/MODIFY/DELETE/RENAME đều có unit test riêng, chạy trên cả file `.js` và `.php`; sau RENAME, `imports_exports` trỏ tới file đó vẫn còn nguyên bất kể ngôn ngữ | ✅ Done — ma trận đủ 4 case × 2 ngôn ngữ, `is_broken` cho quan hệ đứt, 24/24 test xanh |
| NF-021 | Dependency graph (import resolution): resolve specifier → `file_id` đích. JS: relative path resolution, `node_modules` → `external: true`. PHP: `require`/`include` đường dẫn tương đối → resolve như JS; `use` namespace → giữ `external: true`. ~~build `calls`/`references`~~ → tách sang NF-021b (xem bên dưới) | `src/modules/index/` | NF-020 | M | `import { login } from './auth.js'` → edge đúng tới `file_id` của `auth.js`; `require_once __DIR__.'/auth.php'` → edge đúng tương tự; `import express from 'express'` và `use App\Services\Auth;` → đều đánh dấu external, không lỗi | ✅ Done — `dependency-graph.js` resolve đúng cả JS/PHP, tự động thay edge khi MODIFY, đánh dấu hỏng khi DELETE. 27/27 test xanh. Phạm vi `calls`/`references` tách sang NF-021b (ticket phát sinh, không thuộc backlog gốc — sprint leader chấp nhận, xem ghi chú dưới bảng) |
| NF-021b *(mới, phát sinh)* | `calls` (MVP theo tên, chưa full type resolution): mở rộng `contract.js` thêm `calls: [{callee_name, line, caller_symbol}]` cho extractor NF-019/NF-019b. Indexer resolve: khớp `callee_name` với symbol cùng file → edge nội bộ; khớp với `imports[].local` → edge tới `file_id` của file import; không khớp → bỏ qua, không đoán. **`references` table: KHÔNG nằm trong ticket này** — để trống schema, tách ticket riêng sau | `src/modules/index/parser/`, `src/modules/index/` | NF-021 | M | Function A gọi function B cùng file → `calls` có edge đúng; A gọi hàm đã import từ file khác → edge tới đúng `file_id`; gọi hàm không xác định được nguồn (vd. method trên object không biết type) → không tạo edge, không throw | ✅ Done — PHP resolve theo symbol trong file `require` (không phải qua alias như JS, đúng bản chất PHP). Test cùng file + require + JS import đều có. 33/33 test xanh |
| NF-022 | `forge index rebuild`: xoá sạch `index.db`, quét lại toàn bộ project theo ignore list, index lại từ đầu; cộng thêm consistency checker tự phát hiện index lệch → tự phát `index.inconsistent` rồi tự rebuild | `src/transport/cli/`, `src/modules/index/` | NF-017, NF-019, NF-020 | M | Xoá tay `index.db` giữa chừng → `forge index rebuild` phục hồi đúng 100% file/symbol so với trước; giả lập 1 file bị index nhưng đã xoá trên đĩa → checker tự phát hiện | ✅ Done — dùng chung ignore với watcher, smoke test CLI thật trên chính repo Nodeforge (28 file). 35/35 test xanh |
| NF-023 | Nối Watcher → Index qua `internalBus` (EventEmitter nội bộ, private trong `src/bootstrap/`, KHÔNG phải Event Store Sprint 7); payload đúng field tối thiểu của `core/event.schema.json` | `src/bootstrap/`, `src/modules/watcher/`, `src/modules/index/` | NF-015, NF-016, NF-020 | S | Sửa file → watcher phát `file.modified` lên `internalBus` → index module tự động re-index, không cần gọi thủ công | ✅ Done — **pipeline end-to-end hoạt động thật**: sửa file → watcher → bus (Ajv validate) → indexer, không gọi thủ công. Lifecycle dọn sạch listener/handle khi stop. 36/36 test xanh |
| NF-024 | Integration test: sửa file thật trong project fixture → đo thời gian tới khi index cập nhật | `tests/integration/` | NF-023 | S | Độ trễ sửa file → index cập nhật < 1s | ✅ Done — đo thật 216–227ms (chủ yếu là debounce 200ms), polling tới khi thấy thay đổi thật, không sleep cố định. 37/37 test xanh |
| NF-025 | Integration test: rename file có import/test liên quan → xác nhận quan hệ không đứt | `tests/integration/` | NF-023, NF-021 | S | Rename file được import bởi file khác → sau rename, file kia vẫn resolve đúng dependency edge tới `file_id` cũ (path mới) | ✅ Done — end-to-end qua watcher thật; phát hiện + sửa bug thứ tự event add/unlink ở NF-016 (nay có unit test riêng — ghi nhận NF-016 đã được vá 1 bug thật trong lúc làm ticket này). 39/39 test xanh |
| NF-026 | Stress test: ghi liên tiếp nhiều file cùng lúc (mô phỏng Agent ghi hàng loạt) → xác nhận debounce không làm rớt event, không double-index | `tests/integration/` | NF-023 | S | Ghi 20 file đồng thời trong <1s → index có đúng 20 file, không thiếu không trùng | ✅ Done — 20/20 file, path, symbol đúng; không rớt/trùng event; toàn bộ pipeline xong trong 1.8s. 40/40 test xanh |
| NF-027 | Exit check Sprint 1: tổng hợp toàn bộ test unit + integration | Tất cả trên | — | S | `npm test` xanh 100% cho `tests/unit` + `tests/integration` liên quan Sprint 1 | ✅ Done — Sprint 1 Gate đầy đủ: `npm test` 40/40 pass (2666ms), `npm run lint` pass (0 problems), `npm run typecheck` pass (tsc `--project jsconfig.json`, `allowJs`+`noEmit` — **giới hạn tự khai báo:** chưa bật `checkJs`, mới là compiler/syntax gate, chưa static type check đầy đủ qua JSDoc — ghi nhận cho Sprint 4 cân nhắc khi build verification runner thật), `validate:schemas` 33/32 không đổi, `bootstrap:smoke` không leak handle, `git diff --check` pass. 3 điểm treo NF-014/016/017 đã giải trình dứt điểm (xem cập nhật ở từng dòng) |

**Ước tính:** S=nhỏ, M=vừa, L=lớn (theo quy ước đã dùng ở Sprint 0).

### Test fixture cần chuẩn bị trước (song song NF-014)

```
tests/fixtures/sample-project/
├── src/
│   ├── auth.js            # có login/refreshSession/logout

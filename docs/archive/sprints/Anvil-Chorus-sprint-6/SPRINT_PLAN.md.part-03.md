<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
│   ├── security/           # đích rename thử nghiệm
│   └── Auth.php            # class + method + require_once + use namespace, cho NF-019b/020/021
├── tests/
│   └── auth.test.js        # để thử tests_map sau này
├── node_modules/.gitkeep   # để test ignore
├── composer.json           # tối thiểu, chưa cần autoload map thật (xem mục PHP ở trên)
└── package.json
```

Không phải ticket riêng — gộp làm phần chuẩn bị của NF-024/025/026.

### Rủi ro cần Builder lưu ý khi code

| Rủi ro | Ảnh hưởng | Hướng xử lý đề xuất |
|---|---|---|
| chokidar không native hỗ trợ "rename" trên mọi OS (khác nhau giữa Linux/macOS/Windows) | NF-016 có thể hoạt động khác nhau theo platform | Heuristic dựa content-hash + cửa sổ thời gian là platform-agnostic — không dựa vào flag riêng của chokidar theo OS |
| Babel parser lỗi cú pháp (file có lỗi syntax tạm thời trong lúc Agent đang gõ dở) | NF-019/020 có thể throw giữa chừng khi Agent đang ghi file chưa xong | Bắt buộc chờ file "stable" (NF-015) trước khi parse; nếu parse vẫn lỗi → log warning, giữ nguyên symbol cũ trong index thay vì xoá, không throw làm crash cả pipeline |
| Rebuild toàn bộ (NF-022) trên project lớn có thể chậm | Vi phạm ngầm "đừng để `forge index rebuild` treo UI" | Rebuild chạy bất đồng bộ theo batch, không block; benchmark thật để Sprint 9 (Hardening/load test) |
| `internalBus` dễ bị lạm dụng thành Event Store tạm thời nếu không rào rõ | Sprint 7 phải refactor nhiều hơn cần thiết | Đặt rõ trong code comment: `internalBus` chỉ dùng nội bộ watcher↔index, không export ra `src/application/` hay `src/transport/` |
| PHP `use` namespace không resolve được `file_id` thật (chưa đọc PSR-4 autoload map) | Dependency graph PHP "rỗng hơn" JS thật — mọi `use` đều `external: true` kể cả class nội bộ project | Chấp nhận ở Sprint 1 (đã nêu rõ ở trên); resolve PSR-4 thật là ticket riêng cho sprint sau |
| Extractor registry là interface mới, JS extractor và PHP extractor code song song → dễ lệch shape trả về nếu không thống nhất trước | NF-020 phải sửa lại nếu 2 extractor trả shape khác nhau | Chốt cứng shape JSON ở trên trước khi NF-019/NF-019b bắt đầu song song |
| `node:sqlite` là API experimental (NF-017) | Có thể breaking change giữa các Node minor version, ảnh hưởng toàn bộ `src/infrastructure/sqlite/` và mọi module phụ thuộc | **Đã chốt ở NF-027:** giữ `node:sqlite`, chấp nhận rủi ro (xác nhận `ExperimentalWarning` trên Node v24.13.0), không chuyển `better-sqlite3` trước Sprint 2 — theo dõi tiếp khi Node stabilize API |

### Exit criteria

- [x] NF-024: sửa file → watcher bắn event → index cập nhật đúng trong < 1s (216–227ms thật)
- [x] NF-025: rename file → quan hệ (imports/tests/history) không bị đứt
- [x] check-result (lint/typecheck) PASS cho toàn bộ code Sprint 1 — `eslint` + `tsc --project jsconfig.json` (`allowJs`+`noEmit`, chưa `checkJs` — xem ghi chú NF-027)
- [x] NF-027 tổng hợp: `npm test` 40/40 pass

### Sprint 1 — ĐÓNG (phạm vi gốc: NF-014→027)

Sprint 1 Gate đầy đủ: `npm test` 40/40, `npm run lint` pass, `npm run typecheck` pass (giới
hạn: chưa `checkJs`, ghi nhận cho Sprint 4), `validate:schemas` 33/32 không đổi,
`bootstrap:smoke` không leak handle, `git diff --check` pass. 3 điểm treo kiến trúc
(polling NF-014, gộp event NF-016, `node:sqlite` NF-017) đã giải trình dứt điểm, có bằng
chứng kiểm chứng được. Sprint 2 (Project State & Session) được mở khoá.

**Việc mang sang Sprint 2/4 (không phải nợ kỹ thuật bị bỏ quên — ghi chú tường minh):**
- `node:sqlite` vẫn experimental — theo dõi khi Node stabilize API; nếu breaking, đây là
  điểm cần sửa đầu tiên trước khi mở rộng `.forge/runtime/index.db` ở Sprint 2.
- `typecheck` hiện chỉ là compiler/syntax gate (`allowJs`+`noEmit`, chưa `checkJs`) — Sprint 4
  (Verification Engine thật) cần quyết định có bật `checkJs` toàn repo hay giữ nguyên mức
  hiện tại khi build `results/check-result.schema.json` runner.

### Mở lại Sprint 1 — NF-038 (`forge watch`)

> **Đóng sprint không phải khoá vĩnh viễn** — đúng tiền lệ đã dùng ở Sprint 0 (mở lại cho
> NF-028–037). Phạm vi gốc NF-014→027 vẫn giữ nguyên trạng thái Done, không re-open lại các
> ticket đó; chỉ thêm 1 ticket mới cho nhu cầu phát sinh sau khi đóng.

| ID | Ticket | Thư mục | Phụ thuộc | Est. | Acceptance criteria | Trạng thái |
|---|---|---|---|---|---|---|
| NF-038 | `forge watch [path]` — CLI khởi động pipeline Sprint 1 (watcher→internalBus→indexer→SQLite) làm tiến trình chạy thật. `path` optional, mặc định `cwd`. **Khởi động, 3 trường hợp phải phân biệt:** (a) `.forge/` chưa từng tồn tại (project hoàn toàn mới) → gọi `ensureRuntimeDir()` (NF-017) tạo `.forge/runtime/` từ số 0, sau đó full rebuild (tái dùng logic NF-022); (b) `index.db` tồn tại nhưng rỗng → full rebuild như (a), không cần `ensureRuntimeDir()` lại; (c) `index.db` đã có dữ liệu → tin tưởng baseline, không quét lại. Sau baseline (cả 3 case): chokidar `ignoreInitial: true` — chỉ phản ứng thay đổi sau khi watch bắt đầu. Không mở HTTP/WebSocket/SSE (phạm vi Sprint 8) | `src/transport/cli/`, dùng lại `src/bootstrap/`, tái dùng logic rebuild NF-022 | NF-014, NF-015, NF-016, NF-017, NF-020, NF-022, NF-023 | S | (1) Chạy trên `tests/fixtures/sample-project/`, sửa 1 file thật → log index cập nhật; (2) chạy thật trên chính repo Nodeforge (`cd` root repo, `forge watch`, không truyền path) → sửa 1 file trong `src/` → log index cập nhật, dùng đúng ignore list đã xác nhận ở NF-022; (3) **case (a) — project hoàn toàn chưa từng có `.forge/`** → tự tạo `.forge/runtime/` + tự rebuild, không phát `file.created` giả cho file có sẵn qua pipeline watcher — *đây là kịch bản NF-022 CHƯA từng test (NF-022 chỉ test "xoá tay `index.db` giữa chừng", không test "chưa từng có `.forge/` bao giờ"), NF-038 phải tự test riêng, không giả định NF-022 đã cover*; (4) **case (c) — DB đã có dữ liệu** → khởi động lại không đụng row cũ, không lỗi trùng `file_id`; (5) `Ctrl+C` (SIGINT) thoát sạch, không leak handle; (6) không thêm dependency mới ngoài Sprint 1 đã dùng | ✅ Done — Toàn bộ gate PASS thật (lint/typecheck/validate:schemas/bootstrap:smoke/5 unit test/git diff --check) trên cả 3 case (a/b/c), log thật có timestamp trên cả root Nodeforge lẫn fixture. Rủi ro launcher `XSym` (do SMB mount chặn ghi/preserve flag lạ) đã có fix bền vững, **đã commit**: `1bb48989` "fix: auto-repair XSym npm bin launchers via postinstall" — `package.json`, `package-lock.json`, `scripts/repair-npm-bin-links.mjs`, đã lên `origin/master` |

**Vì sao NF-038 không thuộc Sprint 8:** Sprint 8 xây tầng transport tổng quát (HTTP/API,
WebSocket/SSE, nhiều lệnh CLI). `forge watch` chỉ khởi động lại chính pipeline Sprint 1 đã
build, chạy foreground thay vì trong test — không thêm khả năng transport mới. Đúng tiền lệ
NF-022 (`forge index rebuild`) đã làm ngay trong Sprint 1 dù nằm ở `src/transport/cli/`.



### Đề xuất thứ tự giao việc

1. **Ngay:** NF-014 + NF-017 + NF-019 + NF-019b chạy song song (4 nhánh độc lập — NF-019 và
   NF-019b chỉ cần thống nhất shape JSON ở trên trước, sau đó code độc lập nhau).
2. **Sau đó:** NF-015 → NF-016 (nhánh watcher); NF-018 (nối vào NF-017).
3. **Điểm hội tụ:** NF-020 cần cả 3 nhánh xong (storage+file_id, JS extractor, PHP
   extractor) mới bắt đầu được.
4. **Cuối:** NF-021 → NF-022 → NF-023 → (NF-024, NF-025, NF-026 song song) → NF-027.

**Bước tiếp theo (giao ticket mới):** NF-014-CLARIFY / NF-016-CLARIFY / NF-017-CLARIFY — yêu
cầu Builder trả lời 3 điểm treo ở đầu mục này, sau đó NF-027 mới có thể chạy để đóng Sprint 1.

---

## Sprint 2 — Project State & Session

**Mục tiêu:** chốt "Node quản lý trạng thái project thế nào" (mục 58.2) trước khi có Agent
Protocol (Sprint 3). Tài liệu tham khảo đầy đủ: `ARCHITECTURE_SPRINT2.md` (bản trích riêng
từ `ARCHITECTURE.md`, chỉ gồm mục 6/32/33/35/36/37/38/53/57/58/63.1/63.2 — không cần đọc
lại toàn bộ 65 mục gốc).

> **Sửa 1 sai lệch quan trọng so với bản Sprint 2 nháp trước đây:** `project/session.schema.json`,
> `project/project.schema.json`, `project/task.schema.json` **đã tồn tại** trong baseline từ
> commit `d755576` (xác nhận ở NF-013-CLOSE, Sprint 0) — Sprint 2 **review + update có mục
> tiêu**, không "tạo mới" như bảng nháp cũ từng ghi. Nhầm "tạo mới" thành ticket sẽ khiến
> Builder ghi đè lên file đã có, có nguy cơ mất nội dung baseline.

### Bảng phụ thuộc trong-sprint

```
NF-001, NF-013-CLOSE (Sprint 0, đã Done)
   │
   ├─▶ NF-039 (review baseline project/session/task.schema.json vs thiết kế Sprint 2)
   │        │
   │        ▼
   │      NF-039b (gap thật: đổi id→project_id trong project.schema.json)
   │        │
   │        ▼
   │      NF-039c (vá fixture còn thiếu cho project.schema.json)
   │        │
   │        ▼
   │      NF-040 (thêm field commit_id vào task.schema.json)
   │
   ├─▶ NF-041 (Project Registry: project_id, lookup — chờ NF-039b/c xong)
   │        │
   │        ▼
   │      NF-042 (Project isolation: state độc lập multi-project)
   │
   ├─▶ NF-043 (.forge/ layout đầy đủ — mở rộng ensureRuntimeDir từ NF-017 Sprint 1)
   │
   └─▶ NF-044 (Session module thật: link Agent+File, lưu SQLite — cần NF-039 + NF-017)
            │
            ▼
   NF-042 + NF-043 + NF-044 hội tụ ──▶ NF-045 (multi-project isolation test, exit criteria)
            │
            ▼
          NF-046 (exit check tổng hợp Sprint 2)
```

### Backlog

| ID | Ticket | Thư mục | Phụ thuộc | Est. | Acceptance criteria | Trạng thái |
|---|---|---|---|---|---|---|
| NF-039 | Review baseline `project/session.schema.json`, `project/project.schema.json`, `project/task.schema.json` (đã có từ commit `d755576`) đối chiếu thiết kế Sprint 2: `task.status` phải là enum cố định (`pending/active/blocked/completed/failed/cancelled`), tách biệt `task.workflow_state` (string tự do khớp `workflow.states` của `task.workflow_id`) — README v1.2, mục "Task.status vs Workflow.states". Không sửa file nếu đã đúng, chỉ báo cáo gap nếu có | `schemas/project/` (review only) | NF-013-CLOSE | S | Báo cáo dứt khoát: baseline đã đúng thiết kế hay có gap cụ thể (field nào, sai gì) — không trả lời chung chung "ổn" | ✅ Done — 3/4 điểm khớp đúng thiết kế (path:line cụ thể: `task.schema.json:97/100` enum status, `:90/83/95` workflow_state tách biệt, `session.schema.json:6/8` object chính thức); **1 gap thật**: `project.schema.json` dùng field `id` thay vì `project_id` như ví dụ gốc mục 36 `ARCHITECTURE.md` — tách sang NF-039b |
| NF-039b | Đổi field `id` → `project_id` trong `project/project.schema.json`, khớp ví dụ gốc mục 36 `ARCHITECTURE.md` | `schemas/project/project.schema.json` | NF-039 | S | Đổi field, giữ nguyên kiểu/ràng buộc khác; grep toàn repo xác nhận không có schema/code nào khác tham chiếu field cũ; `validate:schemas` không vỡ; chặn NF-041 tới khi xong | ✅ Done — đổi `required`+`property` tại dòng 8/14; grep xác nhận không có tham chiếu nào khác trong repo; `validate:schemas` pass 33/32 (không đổi số, đúng kỳ vọng vì baseline chưa từng có fixture cho `project.schema.json` — phát hiện thêm ở NF-039c) |
| NF-039c | Thêm fixture `schemas/examples/project.json` + đăng ký vào `scripts/validate-schemas.mjs` — vá lỗ hổng `project.schema.json` chưa từng được test tự động | `schemas/examples/project.json` (mới), `scripts/validate-schemas.mjs` | NF-039b | S | `validate:schemas` báo **33 schemas, 33 fixtures** (không đổi số schema, tăng đúng 1 fixture — *sửa lại số 34 mình gõ nhầm lúc giao ticket, đúng ra phải là 33*); fixture dùng `project_id`, không dùng `id` | ✅ Done — output thật: `Validated 33 schemas and 33 fixtures`, breakdown `project: 6` (tăng từ 5); fixture dùng đúng `project_id`. Không có invalid fixture (validator hiện chưa có cơ chế negative fixture — hạn chế hạ tầng có sẵn, không phải né việc) |
| NF-040 | Thêm field optional `commit_id` vào `project/task.schema.json` (trỏ ngược Commit đã dispatch task đó — ARCHITECTURE mục 63.1, xem `ARCHITECTURE_SPRINT2.md`). Task **không** tự có `status` runtime riêng ngoài field đã có — chỉ thêm đúng 1 field tham chiếu | `schemas/project/task.schema.json` | NF-039 | S | `commit_id` optional (không bắt buộc — task tạo ngoài luồng Commit Dispatcher vẫn hợp lệ); fixture có/không có `commit_id` đều validate qua ajv; `validate:schemas` vẫn xanh, số schema không đổi (chỉ sửa field, không thêm file) | ✅ Done — field thêm tại dòng 22, dùng chung `$defs/id` (không tự định nghĩa ràng buộc mới), không đưa vào `required` (vẫn kết thúc ở `created_at`); 2 fixture: `task.json` (không có `commit_id`, baseline có sẵn) + `task-with-commit.json` (mới, có `commit_id`); `validate:schemas`: 33 schema (không đổi) / 34 fixture (+1, khớp đúng vì `task.json` đã tồn tại từ trước — chỉ `task-with-commit.json` là mới); grep xác nhận `commit_id` trong `verification/*` là entity khác (Commit tự thân), không xung đột với Task |
| NF-041 | Project Registry: sinh `project_id` ổn định, lookup theo path/id (mục 35/36, `ARCHITECTURE_SPRINT2.md`) | `src/modules/projects/` | NF-001, NF-039b, NF-039c | M | 2 project khác path → 2 `project_id` khác nhau, ổn định qua nhiều lần mở lại (không sinh lại mỗi lần); dùng đúng field `project_id` (không dùng `id`) | ✅ Done — `project-registry.js`: UUID opaque `project_id`, lưu `.forge/runtime/project.json` (tái dùng `ensureRuntimeDir()` từ NF-017), đọc lại khi restart/move cùng `.forge`, validate qua `project.schema.json` (dùng đúng `project_id`, không dùng `id`); tích hợp vào `watch-project.js`, bỏ fallback suy path. Gate đầy đủ retest sau sự cố môi trường SMB (`EACCES` ở `postinstall`, cùng nhóm lỗi mount với NF-038): `npm install` sạch (`postinstall` tự báo "healthy"), lint pass, typecheck pass, `npm test` 49/49, `validate:schemas` 33/34. **Rủi ro SMB/EACCES đã qua vòng thử thách thứ 2** (lần 1: `XSym` launcher ở NF-038; lần 2: `EACCES` ngay trên chính script tự sửa) — persistent fix (`postinstall` + `repair-npm-bin-links.mjs`, đã commit từ NF-038) tự phục hồi được cả 2 lần, nhưng đây là mount SMB dễ vỡ, cần theo dõi tiếp ở các sprint sau, không coi là đã hết rủi ro vĩnh viễn |
| NF-042 | Project isolation: state của N project mở song song hoàn toàn độc lập — không đọc/ghi nhầm `.forge/runtime/` của project khác (mục 57) | `src/modules/projects/` | NF-041 | M | Mở 2 project, sửa file ở project A → chỉ `index.db` của A cập nhật, B không đổi | ✅ Done — mỗi project 1 `internalBus` riêng trong từng `createBootstrap()` instance (không share process-wide bus), invariant ghi tại `src/bootstrap/index.js:57` — loại bỏ hẳn khả năng lẫn event giữa project thay vì chỉ lọc theo `project_id`. Test isolation (1 test gộp assertion, `tests/integration/project-isolation.test.js:23`): 2 `project_id` khác nhau, SQLite A/B kiểm tra trực tiếp cả 2 chiều, B vẫn index sau khi đóng A. Regression single-project (7/7, tái dùng đúng tên test từ NF-022/038): `forge index rebuild`, `forge watch` (baseline mới/rỗng/có sẵn, đóng handle sạch, SIGINT) đều không bị ảnh hưởng. Gate: `npm test` 50/50, lint/typecheck/validate:schemas (33/34)/`git diff --check` đều pass |
| NF-043 | `.forge/` layout đầy đủ khi mở project lần đầu: mở rộng `ensureRuntimeDir()` (đã có từ NF-017, Sprint 1) thành `schemas/ rules/ workflows/ roadmap/ runtime/` (mục 53, `ARCHITECTURE_SPRINT2.md`). `rules/`+`workflows/` copy default từ root repo (STRUCTURE.md: "Committed default Node policy/rulesets") vào `.forge/rules/`, `.forge/workflows/` của từng project — không tạo rỗng | `src/infrastructure/` | NF-017 (Sprint 1, Done) | M | Mở project mới → đủ 5 thư mục con `.forge/`; `.forge/rules/`+`.forge/workflows/` có nội dung copy từ default, không rỗng; `.forge/runtime/` vẫn đúng hành vi cũ (index.db hoạt động, không đổi behavior NF-017/022/038) | ✅ Done — `forge-layout.js`: gọi nguyên `ensureRuntimeDir()` (không sửa hàm cũ), tạo thêm `schemas/rules/workflows/roadmap`; `rules/`+`workflows/` copy (không symlink), chỉ copy khi đích chưa tồn tại (không ghi đè tuỳ biến khi mở lại project — có test riêng xác nhận); `roadmap/` chỉ `mkdir`, không tự sinh `roadmap.json`. Tích hợp vào Project Registry (NF-041) và `forge index rebuild` (NF-022). **Xác nhận không mất test cũ qua tích hợp:** dán đầy đủ tên 52/52 test — `forge index rebuild restores...`, 5 test `forge watch` (baseline mới/rỗng/có sẵn/SIGINT/path), 4 test Project Registry, `project-isolation`, đều còn nguyên và pass. Gate: lint/typecheck/`validate:schemas` (33/34)/`git diff --check` đều pass |
| NF-044 | Session module — **persistence + schema** (đã thu hẹp phạm vi khi giao ticket): sinh `session_id` ổn định gắn `project_id` (NF-041), lưu SQLite (tái dùng adapter NF-017), validate qua `project/session.schema.json` (đã review NF-039). **KHÔNG bao gồm** theo dõi hành động Agent↔File thật (mục 32 đầy đủ cần Agent Protocol Sprint 3 phát sinh dữ liệu + History Sprint 7 lưu trữ dài hạn — chưa tồn tại ở Sprint 2, không tự mô phỏng Agent giả) | `src/modules/projects/` | NF-039, NF-017, NF-041 | M | Tạo session → `session_id` ổn định, đúng `project_id`; đóng session + restart → dữ liệu còn nguyên; fixture validate qua ajv; không tạo module/class mô phỏng Agent | ✅ Done — `session-store.js`: bảng riêng `project_sessions` trong SQLite hiện có (không đụng `files`/`symbols`), AJV validate qua `project/session.schema.json` khi tạo/đóng. Xác nhận scope thu hẹp đúng yêu cầu: không tạo Agent class/mock, schema không có `agent_id` đơn lẻ mà là `agents: string[]` (chỉ lưu, không xác thực). Quy ước PK/FK: `id` là PK tự thân của Session, `session_id` là FK tham chiếu ở Agent/Event/Command/Context/Result — không phải gap. Test đầy đủ tên: `creates a schema-valid session with a stable project_id and persists it after restart`, `rejects session records that violate project/session.schema.json` (có test reject). 54/54 pass, không mất test cũ. Gate: lint/typecheck/`validate:schemas` (33/34)/`git diff --check` đều pass |
| NF-045 | Integration test: multi-project isolation (exit criteria gốc) — **thu hẹp khi giao ticket**: không lặp lại test pipeline isolation đã có ở NF-042, chỉ xác nhận `.gitignore` đúng ranh giới PLAN/STATE cho `.forge/` | `tests/integration/` | NF-042, NF-043, NF-044 | S | `.gitignore` đúng: `.forge/runtime/` bị ignore; `rules/`+`workflows/`+`roadmap/` **không** bị ignore, commit được như config; dùng `git check-ignore`/Git thật, không đoán bằng mắt | ✅ Done — `tests/integration/forge-gitignore.test.js`, tạo repo tạm + Git thật xác nhận cả 2 chiều: `.forge/runtime/index.db` bị ignore, `.forge/rules/`+`workflows/`+`roadmap/` không bị ignore và `git add` được. Root `.gitignore` đã đúng sẵn, không cần sửa. 55/55 pass (+1 đúng test mới), không trùng coverage NF-042. Gate: lint/typecheck/`validate:schemas` (33/34)/`git diff --check` đều pass |
| NF-046 | Exit check Sprint 2: tổng hợp toàn bộ | Tất cả trên | — | S | `npm test` xanh 100%, `npm run lint`, `npm run typecheck`, `npm run validate:schemas`, `npm run bootstrap:smoke`, `git diff --check` đều xanh — đúng format Sprint 1 Gate đã dùng | ✅ Done — 55/55 test (đầy đủ tên đã xác nhận, gồm `isolates two concurrent project pipelines...`, `ignores Forge runtime state while keeping rules, workflows, and roadmap trackable`); lint/typecheck/`validate:schemas` (33/34)/`git diff --check` đều pass. Rà soát rủi ro mang từ trước: SMB/EACCES **không tái diễn** trong suốt NF-042→045; `node:sqlite` experimental vẫn cảnh báo quen thuộc nhưng **không phát sinh lỗi mới** kể cả khi Session module (NF-044) dùng chung adapter |

**Ước tính:** S=nhỏ, M=vừa, L=lớn.

### Rủi ro cần lưu ý

| Rủi ro | Ảnh hưởng | Hướng xử lý đề xuất |
|---|---|---|
| NF-039 tưởng baseline "chắc đã đúng" rồi bỏ qua review thật | Gap ẩn trong `task.status`/`workflow_state` chỉ lộ ra ở Sprint 6 (Workflow Engine), sửa muộn tốn kém hơn | Bắt buộc NF-039 phải có báo cáo dứt khoát, không suy đoán — đúng nguyên tắc đã áp dụng suốt Sprint 0/1 |
| NF-043 ghi đè `.forge/runtime/` đang hoạt động từ Sprint 1 | Phá vỡ `forge watch`/`forge index rebuild` đã Done | NF-043 chỉ **mở rộng** `ensureRuntimeDir()`, không viết lại — test phải xác nhận NF-017/022/038 vẫn hoạt động sau khi thêm 4 thư mục con mới |
| Copy default `rules/`/`workflows/` từ root vào mỗi `.forge/` — nếu root default sau này đổi, các project cũ không tự đồng bộ | Config lệch dần giữa các project theo thời gian | Chấp nhận ở Sprint 2 (đây là bản chất "copy lúc khởi tạo", không phải symlink) — nếu cần đồng bộ lại, đó là tính năng riêng (`forge rules sync` chẳng hạn), không thuộc Sprint 2 |
| Môi trường dev chạy trên **SMB mount dễ vỡ** — đã gây lỗi 2 lần khác nhau (NF-038: `XSym` launcher; NF-041: `EACCES` ngay trên script tự sửa) | Mỗi lần `npm install`/thao tác filesystem đặc biệt có nguy cơ chặn toàn bộ gate, tốn thời gian debug lặp lại | `postinstall` + `repair-npm-bin-links.mjs` (từ NF-038) đã tự phục hồi được cả 2 lần — theo dõi tiếp, không coi là hết rủi ro; nếu tái diễn lần 3, cân nhắc chuyển hẳn sang filesystem local thay vì tiếp tục vá từng triệu chứng |

### Exit criteria

- [x] NF-045: mở 2 project song song, state không lẫn nhau
- [x] `.forge/runtime/` gitignore; `rules/`+`workflows/`+`roadmap/` commit như config
- [x] NF-046 tổng hợp: toàn bộ gate xanh

### Sprint 2 — ĐÓNG

8 ticket (NF-039→046, gồm 2 ticket phát sinh từ review NF-039b/c) đều Done. Điểm đáng chú ý
nhất của sprint này: review nghiêm túc 1 ticket tưởng chừng đơn giản (NF-039 — chỉ review
baseline) đã kéo ra 1 gap thật (`project.schema.json` dùng `id` thay vì `project_id`, lệch
ví dụ gốc mục 36 ARCHITECTURE.md) và 1 lỗ hổng coverage (`project.schema.json` chưa từng có
fixture từ Sprint 0) — cả 2 đều được vá trước khi Project Registry (NF-041) code lên trên
nền đó, tránh Registry phải sửa lại lần 2. Rủi ro SMB/EACCES tái diễn 1 lần nữa ở NF-041
nhưng không lan sang các ticket sau. `node:sqlite` experimental tiếp tục ổn định qua Session
module. Sprint 3 (Agent Protocol) được mở khoá.

---

## Sprint 3 — "Bridge" (Agent Protocol)

> Tên mã: **Bridge** (Cầu) — nối Agent (bất kỳ provider nào) với Node qua 1 giao thức chuẩn,
> không lệ thuộc model cụ thể. Trích từ `SPRINT_PLAN.md`, kèm tài liệu tham khảo riêng
> `ARCHITECTURE_SPRINT3.md`.

**Mục tiêu:** chốt "Agent ↔ Node nói chuyện bằng gì" (mục 58.1) — hợp đồng quan trọng nhất về
mặt thiết kế trong 5 thứ cần chốt trước khi code Node. Tài liệu tham khảo đầy đủ:
`ARCHITECTURE_SPRINT3.md` (bản trích riêng từ `ARCHITECTURE.md`, chỉ gồm mục
3/4/5/6/29/40/41/42/44/45/52/58.1).

**Nền đã có sẵn từ Sprint 0–2 (không làm lại):**
- `core/agent.schema.json` (NF-007) — `capability_scopes`, phân biệt Node/AI profile.
- `core/envelope.schema.json` (NF-003) — bọc Event/Command, có `$defs.id`/`timestamp`/`version`.
- `core/event.schema.json` + `core/command.schema.json` (NF-005/006) — enum `type`, nguồn sự
  thật duy nhất, convention `domain.action` snake_case.
- `project/session.schema.json` + `session-store.js` (NF-039/044, Sprint 2) — persistence, chưa
  gắn Agent thật (cố ý thu hẹp phạm vi lúc đó).
- `internalBus` (NF-023, Sprint 1) — EventEmitter nội bộ watcher↔index, **tái dùng** cho
  Agent↔Index, không tạo cơ chế mới.

### Bảng phụ thuộc trong-sprint

```

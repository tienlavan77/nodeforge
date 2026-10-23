# Nodeforge — Kế hoạch Sprint triển khai

Dựa trên `ARCHITECTURE.md` (mục 58–59: 5 thứ cần chốt trước khi code Node + thứ tự ưu tiên),
`STRUCTURE.md` (bố cục `src/modules/`) và `README.md` (contract schema v1.2). Thứ tự sprint đi
theo nguyên tắc: **cái gì mọi module khác phụ thuộc thì làm trước** (Schema → Watcher/Index →
State → Protocol → Verification → Rule/Context → Workflow → Transport → Hardening).

Mỗi sprint là một **workflow_state** hợp lệ cho `task.workflow_id = "nodeforge-build"`
(khớp nguyên tắc `task.status` thô + `task.workflow_state` chi tiết trong README). Exit
criteria của mỗi sprint = check-result (build/lint/typecheck) PASS + test-result PASS cho
module tương ứng, đúng tinh thần "Node chạy verification chính thức".

---

## Vì sao thứ tự sprint lệch so với thứ tự liệt kê ở mục 58

Mục 58 liệt kê 5 thứ cần chốt theo thứ tự: **Agent Protocol → Project State → Schema →
Filesystem Watch/Index → Failure/Recovery**. Đó là thứ tự *quan trọng về mặt khái niệm/thiết
kế* — Agent Protocol đứng đầu vì nó là ranh giới quan trọng nhất giữa Agent và Node. Nhưng đó
**không phải** thứ tự nên *code*, vì có dependency ngược nếu làm đúng y trình tự đó:

| # | Mục 58 | Vấn đề nếu code đúng thứ tự này |
|---|---|---|
| 1 | Agent Protocol | Bản chất là một tập message serialize qua Schema — chưa có Schema thì không có gì để định nghĩa protocol lên trên |
| 2 | Project State | Cũng serialize qua Schema (`project/session.schema.json`, `task.schema.json`...) |
| 3 | Schema | Đứng thứ 3 nhưng thực ra là nền của cả 4 mục còn lại — nếu code Agent Protocol/Project State trước, đổi Schema sau sẽ phải refactor lại (đúng bài học "một enum, không nhân đôi" mà README v1.2 tự nhắc) |
| 4 | Filesystem Watch + Index | Là mục **duy nhất không phụ thuộc Agent/AI** — kỹ thuật thuần (file đổi → đọc → cập nhật index), dễ làm sớm nhất và ít rủi ro nhất, lại là nền để test Failure/Recovery sau này (vd. debounce/file-stability ở mục 9) |
| 5 | Failure/Recovery | Đứng cuối là hợp lý kể cả khi code — không thể thiết kế crash/timeout/retry cho protocol/state/watcher *chưa tồn tại* |

Mục 59 (danh sách phẳng "Filesystem, Watcher, Index, Schema, State, History, Test, Workflow,
Agent Protocol, Context normalization" — không đánh số ưu tiên rõ) ủng hộ cách đọc theo
dependency kỹ thuật hơn là theo thứ tự liệt kê thô ở mục 58.

**Thứ tự code áp dụng trong roadmap này:** Schema → Watcher/Index → Project State →
Agent Protocol → Failure/Recovery (Sprint 9), xen giữa là Verification/Rule/Context/Workflow/
Events theo đúng dependency thực tế của từng module.

---

## Sprint 0 — Schema Foundation & Bootstrap

**Mục tiêu:** có một nguồn sự thật (`schemas/core`) trước khi bất kỳ module nào code, tránh lặp
lại lỗi "hai enum độc lập" mà v1.1 từng gặp.

| Việc | Thư mục | Ghi chú |
|---|---|---|
| Envelope, Agent, Event, Command, Error, Common | `schemas/core/` | `type` enum ở đây là nguồn sự thật duy nhất |
| Node profile (subset enum) | `schemas/node/` | dùng `allOf` tham chiếu core, không tự định nghĩa enum |
| Composition root, config loader, lifecycle | `src/bootstrap/` | |
| Error, IDs, logging, generic utils | `src/shared/` | `file_id` ổn định (mục 12 ARCHITECTURE) phải có từ đây |

**Exit:** schema core validate được bằng JSON Schema validator; `src/bootstrap/` khởi động
process rỗng không lỗi; `src/shared/` có test unit cho ID generator.

### Backlog — Sprint 0 (bắt đầu từ scaffold trắng)

Repo hiện chưa có gì, nên NF-001 là ticket chặn tất cả (mọi ticket khác cần có chỗ để code vào).
Thứ tự dưới đây = thứ tự nên làm; ticket trong cùng một hàng "song song" có thể làm đồng thời.

| ID | Ticket | Phụ thuộc | Est. | Acceptance criteria | Trạng thái |
|---|---|---|---|---|---|
| NF-001 | Scaffold cấu trúc repo theo `STRUCTURE.md` (folder rỗng có `.gitkeep`, `package.json` — JavaScript thuần, `.eslintrc`, `jsconfig.json` nếu cần path alias, `.gitignore` có `.forge/runtime/`) | — | S | `npm install` chạy được; cây thư mục khớp 100% `STRUCTURE.md`; không có file `.ts`/`tsconfig.json` nào trong repo | ✅ Done — đã xác minh |
| NF-002 | `schemas/core/common.schema.json` — `$defs`: `severity`, `capability_scope`, các type dùng chung | NF-001 | M | Có `$defs.severity`, `$defs.capability_scope`; validate bằng JSON Schema draft hợp lệ | ✅ Done — đã xác minh, vocabulary `resource`/`actions` vẫn mở cho NF-007 |
| NF-003 | `schemas/core/envelope.schema.json` | NF-002 | S | Envelope bọc được mọi payload Event/Command mẫu | ✅ Done — 25 schema/15 example parse sạch, $ref nội bộ resolve đúng |
| NF-004 | `schemas/core/error.schema.json` | NF-002 | S | Có `code`, `message`, `details` tối thiểu | ✅ Done — tái dùng `$defs.severity`, có example |
| NF-005 | `schemas/core/event.schema.json` — nguồn sự thật enum `type` cho toàn hệ thống | NF-002 | M | enum `type` đầy đủ mọi event Node lẫn AI agent có thể phát | ✅ Done — 48 event, prefix `domain.action` snake_case, bao phủ base list |
| NF-006 | `schemas/core/command.schema.json` — nguồn sự thật enum `type` | NF-002 | M | tương tự NF-005 nhưng cho command | ✅ Done — 35 command, cùng convention |
| NF-007 | `schemas/core/agent.schema.json` — có `capability_scopes` dùng chung Node/AI agent, hợp nhất 3 model cũ (`capabilities`, `capability_scopes`, `node-capability.schema.json`) | NF-002 | M | Node và AI agent cùng validate qua 1 schema, không còn `capabilities` mảng phẳng riêng; `node-capability.schema.json` deprecated | ✅ Done — đã fix `type: "array"` toàn bộ nhánh `actions.allOf`, validate xanh |
| NF-008 | `schemas/node/node-event.schema.json` — `allOf` tham chiếu + thu hẹp NF-005 | NF-005 | S | Không tự định nghĩa `type` enum; validate reject type ngoài subset Node | ✅ Done — đã fix `type: "object"`, validate xanh |
| NF-009 | `schemas/node/node-command.schema.json` — `allOf` tham chiếu + thu hẹp NF-006 | NF-006 | S | tương tự NF-008 | ✅ Done — đã fix `type: "object"`, validate xanh |
| NF-010 | `src/shared/` — ID generator cho `file_id` ổn định qua rename/move, error types, logger | NF-001 (song song NF-002–009) | M | unit test: rename file vẫn giữ `file_id` cũ | ✅ Done — `file-identity.js`, `file_id` là UUID độc lập path, logger dùng `severity` từ common.schema.json |
| NF-011 | `src/bootstrap/` — config loader, composition root, lifecycle start/stop | NF-001 (song song) | M | `node bootstrap` khởi động rồi tắt sạch không leak handle | ✅ Done — lifecycle idempotent, smoke test xác nhận không leak handle |
| NF-012 | Tooling validate schema (ajv) + script `npm run validate:schemas` + fixture mẫu cho từng schema | NF-003–009 | M | CI fail nếu 1 schema hoặc fixture sai | ✅ Done — ajv 8 + ajv-formats, 12 schema + 14 fixture, CI GitHub Actions; phát hiện đúng 2 lỗi gốc ở NF-007/008/009 |
| NF-013 | Exit check Sprint 0: toàn bộ schema core+node load được, `src/shared` + `src/bootstrap` có test PASS | Tất cả trên | S | `npm test` + `npm run validate:schemas` xanh 100% | 🔵 Đã giao cho Builder — tổng hợp xác nhận cuối Sprint 0 |

**Đề xuất bắt đầu ngay:** NF-001 (chặn mọi ticket khác) → sau đó chạy song song NF-002...NF-009
(schema) với NF-010/NF-011 (shared/bootstrap).

#### Quyết định thiết kế: `capability_scope` (duyệt khi báo NF-002)

Shape đã chốt cho `$defs.capability_scope` trong `common.schema.json`:

```json
{
  "<group tự do, vd. filesystem|shell|context>": [
    { "resource": "string", "actions": ["string", "..."] }
  ]
}
```

Ràng buộc bắt buộc trong schema:
- Mỗi grant có `resource: string` (bắt buộc) + `actions: string[]` với `minItems: 1`, `uniqueItems: true`.
- Grant object `additionalProperties: false` — không cho thêm path/ACL vào đây.
- Không có enum cứng cho `resource`/`actions` ở tầng `common` — vocabulary cụ thể để NF-007 chốt riêng cho Node profile vs AI agent, tránh lặp lỗi "hai enum lệch nhau" từng gặp ở `event.type`/`command.type`.
- Path/ACL (role × path glob × read/write/create/delete/rename/execute × allow/deny × priority) **không** nằm ở đây — thuộc về `project/permission.schema.json` (README, mục Filesystem/Permission/Rule).

#### Quyết định thiết kế: vocabulary `capability_scopes` cho NF-007 (duyệt khi báo NF-007)

Hợp nhất 3 model cũ (`capabilities: string[]`, `capability_scopes`, `node-capability.schema.json`
dạng boolean) về một model duy nhất trong `core/agent.schema.json`.

| Group | Resource | Actions: Node | Actions: AI |
|---|---|---|---|
| filesystem | `project_source`, `project_tests`, `project_config`, `forge_runtime` | read, watch, write, create, delete, rename | read, write, create, delete, rename — riêng `forge_runtime` chỉ `read` |
| shell | `workspace`, `verification` | execute, terminate | execute |
| context | `broker` | build, read_cache, invalidate_cache, redact | request |
| index | `codebase` | read, update, rebuild | không cấp |
| verification | `project` | run_test, run_check | không cấp — AI chỉ yêu cầu qua workflow, không tự chạy verification |
| workflow | `project` | execute, transition, assign_task, pause, resume, cancel | không cấp |
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
| watcher | `file.created`, `file.modified`, `file.deleted`, `file.renamed` |
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

**Mục tiêu:** đây là nền tảng của toàn bộ Forge — không có watcher/index thì Context Engine,
Workflow, Reviewer đều không có dữ liệu.

| Việc | Thư mục | Ghi chú |
|---|---|---|
| Watch CREATE/MODIFY/DELETE/RENAME/MOVE | `src/modules/watcher/` | phải ignore `.forge/**`, `node_modules/**`, `.git/**`, `dist/**`, `coverage/**` (mục 7) |
| Debounce + file-stability check | `src/modules/watcher/` | 100–300ms theo policy, gom nhiều WRITE liên tiếp (mục 9) |
| Incremental index (file/symbol/import/export/call/reference) | `src/modules/index/` | MODIFY → re-index 1 file; CREATE/DELETE/RENAME xử lý riêng (mục 11) |
| `file_id` ổn định qua rename/move | `src/modules/index/` | không dùng path làm identity (mục 12) |
| `.forge/index.db` (SQLite) | `src/infrastructure/` | Code Index là cache, không phải source of truth (mục 13) |
| Lệnh `forge index rebuild` | `src/transport/cli/` hoặc `scripts/` | dùng khi index inconsistent |

**Exit:** test integration: sửa file → watcher bắn event → index cập nhật đúng trong < 1s;
rename file → quan hệ (imports/tests/history) không bị đứt.

---

## Sprint 2 — Project State & Session

**Mục tiêu:** chốt "Node quản lý trạng thái project thế nào" (mục 58.2) trước khi có Agent Protocol.

| Việc | Thư mục | Ghi chú |
|---|---|---|
| Session persistence + `project/session.schema.json` | `src/modules/projects/`, `schemas/project/` | tạo/đóng Session trong SQLite, validate schema và gắn `project_id`; chỉ lưu `agents` như ID string, không theo dõi Agent↔File hay History (để Sprint 3/7) |
| `project/project.schema.json`, `task.schema.json` | `schemas/project/` | `task.status` = enum cố định (pending/active/blocked/completed/failed/cancelled), tách biệt `task.workflow_state` (string tự do khớp `workflow.states`) |
| Registry, project isolation, project state | `src/modules/projects/` | multi-project: mỗi project state độc lập (mục 57) |
| Tạo `.forge/` khi mở project lần đầu | `src/infrastructure/` | cấu trúc đề xuất ở mục 53: `schemas/ rules/ workflows/ runtime/` |

**Exit:** mở 2 project song song, state không lẫn nhau; `.forge/runtime/` được gitignore, `rules/`
và `workflows/` được commit như config.

---

## Sprint 3 — Agent Protocol

**Mục tiêu:** chốt "Agent ↔ Node nói chuyện bằng gì" (mục 58.1) — đây là hợp đồng quan trọng nhất
vì Agent là process độc lập, tự do đọc/ghi filesystem (mục 3–4).

| Việc | Thư mục | Ghi chú |
|---|---|---|
| Provider-neutral agent process protocol + streams | `src/modules/agents/` | Agent ghi file trực tiếp, không qua `WRITE_FILE` API (mục 3, 52) |
| Capability declaration dạng nhóm | `schemas/core/agent.schema.json` | `capability_scopes` dùng chung cho cả Node và AI agent (trước đây AI agent chỉ có mảng `capabilities` phẳng) |
| Agent stream → UI | `src/transport/` | UI chỉ hiển thị, không tự suy luận state (nguyên tắc mục 1) |

**Exit:** một agent giả lập (mock) ghi file thật vào project test, Node watcher thấy event, stream
tới UI qua WebSocket có log đầy đủ.

---

## Sprint 4 — Verification (Test/Build/Lint/Typecheck)

**Mục tiêu:** Node "chạy verification chính thức" — không để AI tự claim là đã pass.

| Việc | Thư mục | Ghi chú |
|---|---|---|
| Test runner | `src/modules/verification/` | `results/test-result.schema.json`: pass/fail count + từng failure |
| Build/Lint/Typecheck runner (gộp chung) | `src/modules/verification/` | `results/check-result.schema.json` (mới): field `kind` phân biệt 3 loại thay vì 3 schema gần giống nhau |
| Git change set / diff | `src/modules/git/` | dùng ở Sprint 5 cho Reviewer |

**Exit:** chạy test/lint/typecheck thật trên project mẫu, kết quả map đúng vào
`check-result`/`test-result`, diagnostic có file/dòng/cột/rule_id.

---

## Sprint 5 — Rule Engine & Context Engine

**Mục tiêu:** hai lớp tách biệt theo README — Permission (tất định, trước khi hành động chạy) và
Rule (đánh giá tốt/tuân thủ, có thể cần AI); song song là Context Engine (Token Firewall).

| Việc | Thư mục | Ghi chú |
|---|---|---|
| `project/permission.schema.json` | `schemas/project/` | role × path glob × access × allow/deny × priority |
| `project/rule.schema.json` + `condition`/`condition_language` | `schemas/project/` | jsonlogic/regex/glob/ast_query để Node tự enforce; `enforcement: orchestrator/blocking` phải kèm `condition` |
| Permission + workflow-rule evaluation | `src/modules/rules/` | |
| Context selection pipeline | `src/modules/context/` | Code Index → symbol → dependency → line-range → dedup → summary → Context Pack |
| `context/context-pack.schema.json` | `schemas/context/` | thêm `index_version` + `generated_at` để tránh dùng context stale (README) |
| `results/review-result.schema.json` | `schemas/results/` | `findings[].severity` dùng chung `common.schema.json#/$defs/severity` |

**Exit:** yêu cầu context cho một symbol trả về đúng "context nhỏ nhất nhưng đủ suy luận", có
`index_version` khớp Code Index hiện tại; một rule có `condition` bị Node tự chặn không cần AI.

---

## Sprint 6 — Workflow Engine

**Mục tiêu:** đồ thị trạng thái cho task, dùng chính `project/workflow-rule.schema.json` và
`project/workflow-ruleset.schema.json` đã định nghĩa ở Sprint 5/README.

| Việc | Thư mục | Ghi chú |
|---|---|---|
| `project/workflow.schema.json` | `schemas/project/` | `states` là mảng string tự do do từng workflow tự định nghĩa |
| `project/workflow-rule.schema.json`, `workflow-ruleset.schema.json` | `schemas/project/` | actor được phép chuyển trạng thái, artifact bắt buộc, dependency gate, allowlist thay đổi, bằng chứng test, Project Owner gate |
| Ruleset mặc định + workflow đồ thị | `rules/forge-sprint-delivery.rules.json`, `workflows/forge-sprint-delivery.workflow.json` | Node phải kiểm tra cả rule lẫn transition trước khi cập nhật `status.json` |
| State-machine execution + handoffs | `src/modules/workflows/` | không hard-code control flow bằng if/else — chạy theo schema (STRUCTURE.md "Boundaries") |
| Flow Builder → Test → Reviewer | `src/modules/workflows/` | theo sơ đồ mục 51: FAIL → Builder lại, PASS → Reviewer → Approve/Changes |

**Exit:** một task chạy hết vòng Builder → Test → Reviewer → Approve qua workflow thật, mọi
transition được kiểm tra rule trước khi ghi `status.json`.

---

## Sprint 7 — Events & History

**Mục tiêu:** audit trail đầy đủ + project memory nén dần theo thời gian (mục 50).

| Việc | Thư mục | Ghi chú |
|---|---|---|
| Event publication, idempotency, subscriptions | `src/modules/events/` | |
| Audit history, summaries, retention | `src/modules/history/` | Raw History → Event Store → Task Summary → Project Memory |

**Exit:** task sau chỉ nhận facts liên quan từ Project Memory, không cần gửi toàn bộ lịch sử cũ.

---

## Sprint 8 — Transport & tích hợp end-to-end

**Mục tiêu:** nối toàn bộ pipeline qua API/WebSocket/CLI thật, không còn mock.

| Việc | Thư mục | Ghi chú |
|---|---|---|
| HTTP/API, WebSocket/SSE, CLI adapters | `src/transport/` | expose state/stream, không phải source of truth |
| Điều phối Builder/Reviewer thật | `src/application/` | use case layer, không biết transport/storage detail |

**Exit:** chạy full loop trên 1 project thật: sửa file → watcher → index → test →
review → approve, xem được trên UI/CLI theo thời gian thực.

---

## Sprint 9 — Hardening: Failure & Recovery

**Mục tiêu:** mục cuối trong "5 thứ cần chốt" — crash, timeout, cancel, retry, concurrent edits;
đồng thời xác nhận multi-project isolation dưới tải thật.

| Việc | Ghi chú |
|---|---|
| Timeout/cancel/retry cho Agent process | mất kết nối Agent giữa chừng không được làm hỏng state |
| Concurrent edits | 2 nguồn ghi cùng file (Agent + human) trong lúc Node đang index |
| Index rebuild tự động khi inconsistent | mục 13 |
| Multi-project load test | mỗi project state độc lập dưới tải đồng thời (mục 57) |

**Exit:** chaos test (kill Agent process giữa task, sửa file ngoài luồng trong lúc index) không
làm Node crash hoặc để lại state rác trong `.forge/`.

---

## Những thứ để sau (theo mục 59 ARCHITECTURE)

Không đưa vào roadmap Sprint 0–9: UI phức tạp, nhiều loại Agent, tối ưu theo provider cụ thể,
advanced memory, visualization nâng cao, distributed deployment.

---

## Bảng phụ thuộc nhanh

```
Sprint 0 (Schema/Bootstrap)
   └─▶ Sprint 1 (Watcher/Index)
          └─▶ Sprint 2 (Project State/Session)
                 └─▶ Sprint 3 (Agent Protocol)
                        └─▶ Sprint 4 (Verification)
                               └─▶ Sprint 5 (Rule/Context Engine)
                                      └─▶ Sprint 6 (Workflow Engine)
                                             └─▶ Sprint 7 (Events/History)
                                                    └─▶ Sprint 8 (Transport/E2E)
                                                           └─▶ Sprint 9 (Hardening)
```

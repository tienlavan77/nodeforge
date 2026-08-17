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
| `project/session.schema.json` | `schemas/project/` | mới trong v1.2 — chính thức hóa `session_id` vốn được tham chiếu khắp Agent/Event/Command/Context/Result nhưng chưa có schema |
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

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
| NF-013 | Exit check Sprint 0 (bản gốc): toàn bộ schema core+node load được, `src/shared` + `src/bootstrap` có test PASS | Tất cả trên | S | `npm test` + `npm run validate:schemas` xanh 100% | ✅ Done — `npm test`: 2/2 pass (bootstrap start/stop sạch, file_id giữ nguyên khi rename — NF-010); `validate:schemas`: core 6 + node 6 = 12 schema, fixture 8 + 6 = 14, khớp đúng phạm vi gốc |

### Mở lại Sprint 0 — bổ sung schema Verification + Roadmap

Sau khi chốt thiết kế ở `ARCHITECTURE.md` mục 62–64 (Verification Engine + Roadmap/Sprint/
Commit), phát sinh 8 schema mới. Lý do đưa vào **Sprint 0** thay vì đợi tới Sprint 4
(Verification) hay tạo sprint riêng: cả 8 schema này **không phụ thuộc kỹ thuật** vào
Watcher/Index/Project State — chúng chỉ tham chiếu nhau qua ID dạng string (`commit_id`,
`result_ref`), không `$ref` chéo sang `results/`, `project/` hay `node/`. Đúng nguyên tắc
đầu Sprint 0: *"có một nguồn sự thật trước khi bất kỳ module nào code"*. Ngoại lệ duy nhất:
`sprint.schema.json` `$ref` tới `commit.schema.json`, `roadmap.schema.json` `$ref` tới
`sprint.schema.json` — cả 3 nằm cùng nhóm `roadmap/`, không tạo phụ thuộc ra ngoài.

Việc `results/test-result.schema.json` và `results/check-result.schema.json` (mà
`verification-run.schema.json` sẽ tham chiếu qua `result_ref`) **vẫn** được tạo ở Sprint 4
như kế hoạch cũ — không đổi. `verification-run.schema.json` không cần `results/` tồn tại
trước để tự nó hợp lệ, vì `result_ref` chỉ là `string`, không phải `$ref` cứng.

| ID | Ticket | Phụ thuộc | Est. | Acceptance criteria | Trạng thái |
|---|---|---|---|---|---|
| NF-028 | `schemas/verification/verification-plan.schema.json` (ARCHITECTURE mục 62.2) | NF-002 | S | `commit_id`, `levels` (enum focused/related/full), `checks[].type` (enum test/lint/typecheck/build) đúng theo mục 62.2; có fixture mẫu | ✅ Done — compile OK qua ajv (draft 2020-12); fixture hợp lệ pass, fixture thiếu `commit_id` reject đúng |
| NF-029 | `schemas/verification/verification-run.schema.json` (mục 62.3) — `checks[].result_ref` là string, KHÔNG `$ref` sang `results/` | NF-002 | S | Validate 1 run mẫu có `result_ref` trỏ ID bất kỳ (chưa cần record thật tồn tại); reject nếu thiếu `status` cấp run | ✅ Done — compile OK; fixture `result_ref: "TESTRESULT-001"` validate pass dù `results/test-result` chưa tồn tại (đúng thiết kế không `$ref` cứng) |
| NF-030 | `schemas/verification/verification-result.schema.json` (mục 62.4) — cổng đọc bởi Workflow Engine | NF-002 | S | `$defs.gate_status` dùng chung cho `status/scope/rules/tests/lint/typecheck/build`; `ready_for_review` bắt buộc | ✅ Done — compile OK; fixture `ready_for_review: true` với 7 gate `passed`/`not_applicable` validate pass |
| NF-031 | `schemas/verification/test-failure.schema.json` (mục 62.5) — `message`/`stack_excerpt` có `maxLength` cứng | NF-002 | S | Fixture message > 500 ký tự → validate reject đúng như thiết kế; fixture hợp lệ pass | ✅ Done — compile OK; fixture message 501 ký tự bị reject đúng lỗi `maxLength`, fixture hợp lệ pass |
| NF-032 | `schemas/verification/verification-policy.schema.json` (mục 62.6) | NF-002 | S | 3 level `focused/related/full` đều bắt buộc có `required`+`stop_on_failure`; `max_retries` không âm | ✅ Done — compile OK; fixture 3 level + `max_retries: 2` validate pass |
| NF-033 | `schemas/roadmap/commit.schema.json` (mục 63.3) — `allowed_change_areas` là glob string, không tự định nghĩa lại ACL (đã có ở `project/permission.schema.json`, Sprint 5) | NF-002 | S | `acceptance_criteria` `minItems: 1`; `verification.levels` dùng đúng enum focused/related/full | ✅ Done — Commit là PLAN thuần, không `status/attempt/review_state`; `verification.levels` `$ref` trực tiếp `verification-plan.schema.json#/properties/levels` (không nhân đôi enum) — fixture gõ sai `"focused-typo"` bị ajv reject đúng, xác nhận `$ref` enforce thật |
| NF-034 | `schemas/roadmap/sprint.schema.json` (mục 63.4) — `commits[]` `$ref` NF-033 | NF-033 | S | Sprint có 2 commit hợp lệ → validate pass; sprint rỗng `commits: []` → reject (`minItems: 1`) | ✅ Done — compile OK; fixture 2 commit thật (COMMIT-001/002 từ Sprint 0) pass, fixture `commits: []` reject đúng |
| NF-035 | `schemas/roadmap/roadmap.schema.json` (mục 63.5) — `sprints[]` `$ref` NF-034 | NF-034 | S | Roadmap mẫu dựa trên chính `SPRINT_PLAN.md` (10 sprint) validate pass qua schema thật | ✅ Done — compile OK; fixture dựng từ đúng 10 sprint thật của `SPRINT_PLAN.md` (Sprint 0→9, tên/objective khớp) validate pass qua schema thật, không phải mock |
| NF-036 | Mở rộng NF-012: thêm 8 schema mới + fixture tương ứng vào `npm run validate:schemas` | NF-028–035 | M | CI vẫn fail đúng nếu 1 trong 8 schema/fixture mới sai; tổng schema tăng từ 12 → 20 | ✅ Done — merged thật qua `scripts/validate-schemas.mjs`; kết quả cuối: `Validated 33 schemas and 32 fixtures` (bao gồm baseline 25 schema core/node/project/context/results + 8 schema mới) |
| NF-037 | Cập nhật `README.md` (cây `schemas/`) khớp `ARCHITECTURE.md` mục 64 — bổ sung `verification/` và `roadmap/` vào phần mô tả bộ schema chính thức | NF-028–035 | S | `README.md` liệt kê đủ 8 file mới, không còn lệch so với `ARCHITECTURE.md` | ✅ Done — `schemas/README.md` cập nhật bởi Builder khi merge |
| NF-013b | Mở rộng NF-013: exit check Sprint 0 giờ gồm cả 20 schema (12 cũ + 8 mới) | NF-013, NF-028–037 | S | `npm test` + `npm run validate:schemas` xanh 100% trên toàn bộ 20 schema | ✅ Done — cả 2 điều kiện treo đã có báo cáo (NF-013-CLOSE): NF-013 gốc PASS (core 6 + node 6 = 12 schema, 14 fixture); nguồn gốc 13 schema `project/context/results` xác nhận là **baseline có sẵn** từ commit `d755576` ("Add Nodeforge architecture and workflow contracts", 2026-08-15 23:03:11), không do bất kỳ NF-ticket nào tạo ra, working-tree sạch trên 13 file đó |

**Baseline có sẵn ngoài phạm vi Sprint 0 (ghi nhận, không phải ticket):** `schemas/project/*`
(8 file: permission, project, rule, session, task, workflow-rule, workflow-ruleset, workflow),
`schemas/context/context.schema.json`, `schemas/results/*` (4 file: check-result, file-change,
review-result, test-result) — tổng 13 schema — đã tồn tại từ commit `d755576`, có trước khi
Sprint 0 của kế hoạch này bắt đầu. Sprint 2 (Project State), Sprint 4 (Verification), Sprint 5
(Rule/Context) **dùng lại** các file này, không tạo mới — nếu nội dung cần sửa đổi để khớp
thiết kế các sprint đó, đó là ticket "cập nhật", không phải "tạo mới".

**Lưu ý cho Sprint 2 (không phải ticket của lần mở lại này):** `project/task.schema.json`
cần thêm field optional `commit_id` (trỏ ngược về Commit đã dispatch task đó — xem
ARCHITECTURE mục 63.1). Ghi chú lại đây để Builder không quên khi code Sprint 2, không tạo
ticket riêng vì Sprint 2 chưa có bảng ticket chi tiết.

---

### Sprint 0 — ĐÓNG

Toàn bộ điều kiện exit đã xác nhận bằng số liệu thật (không phải báo cáo lời): 33 schema hợp
lệ (12 core/node + 13 baseline project/context/results + 8 verification/roadmap mới),
32 fixture validation, `npm test` 2/2 pass, `npm run lint` pass, `npm run bootstrap:smoke`
pass không leak handle, `git diff --check` pass. Sprint 1 (đã có kế hoạch chi tiết ở dưới)
được mở khoá chính thức.

### Mở lại Sprint 0 — lần 2: schema Role/Agent Manifest + vá `rules/forge-sprint-delivery.rules.json`

> Phát sinh từ đối chiếu `FORGE_WORKFLOW_v2.md` + `CONSTITUTION.md`/`WORKFLOW.md` (đã loại bỏ
> phần workflow thất bại, giữ phần nguyên tắc — xem `ARCHITECTURE.md` mục 66). Chỉ đưa vào
> đây phần **không phụ thuộc Workflow Engine (Sprint 6) chưa tồn tại** — đúng tiền lệ Sprint 0
> lần 1 (build `verification/`+`roadmap/` trước cả Sprint 4). Phần phụ thuộc thiết kế state
> machine (`agent-task`, `execution-state`, `execution-event`, `decision`, `specialist-gate`,
> `human-decision`) **cố tình để lại**, không tạo trước — tránh sai shape phải làm lại khi
> Sprint 6 chốt thiết kế thật.

| ID | Ticket | Thư mục | Phụ thuộc | Est. | Acceptance criteria | Trạng thái |
|---|---|---|---|---|---|---|
| NF-057 | `schemas/core/role.schema.json` (mới) — hình thức hoá 5 role quản trị: Project Owner, Sprint Lead, Builder, Reviewer, Architecture Manager. **Không đưa `Node` vào enum này** — Node đã có profile riêng ở `core/agent.schema.json` (`node_capability_scopes`), tránh 2 nơi cùng mô tả Node theo 2 cách. Field tối thiểu: `role_id` (enum, không tự do), `description`, ranh giới trách nhiệm (điều role đó **không được làm**). Đọc `FORGE_WORKFLOW_v2.md` (đã upload) để lấy đúng mô tả từng role, không tự bịa. **Bắt buộc thêm bước nối dây:** sửa `project/workflow-rule.schema.json` field `applies_to` (hiện là string tự do, xem `WF-004`: `"applies_to": ["reviewer", "node"]`) để `$ref`/validate theo đúng `role_id` enum vừa tạo (`node` xử lý riêng, không qua `role.schema.json` — xem ràng buộc trên) — nếu không làm bước này, `role.schema.json` là file không ai đọc, tạo ra 2 nguồn liệt kê role không đồng bộ | `schemas/core/`, `schemas/project/workflow-rule.schema.json` | NF-002 (common.schema.json) | S | Enum `role_id` đủ 5 role (không có `node`); có fixture; `workflow-rule.schema.json` sau khi sửa vẫn validate đúng `WF-001`→`008` hiện có trong `rules/forge-sprint-delivery.rules.json` (không vỡ file cũ); `validate:schemas` xanh, báo số liệu thật | Chưa bắt đầu |
| NF-058 | `schemas/core/agent-manifest.schema.json` (mới) — khai báo capability **tĩnh, thời điểm discovery**. **Phạm vi: áp dụng cho 4 role spawn thành process thật qua Agent Protocol — Builder, Reviewer, Sprint Lead, Architecture Manager** (Architecture Manager giao tiếp với Project Owner qua Node làm trung gian — Command/Event mới "owner gate required/decided", KHÔNG chat trực tiếp ngoài tầm quan sát Node — xem `ARCHITECTURE.md` mục 66.9). KHÔNG áp dụng cho Project Owner (con người, không spawn process) — dùng `role.schema.json` (NF-057) là đủ. Khác `capability_scopes` trong `sessions.start` (NF-053, khai báo **runtime, per-session**) — manifest là khai báo chung trước khi có session nào. `$ref` tới `core/agent.schema.json#/$defs/ai_capability_scopes` đã có | `schemas/core/` | NF-007 (agent.schema.json, Done), NF-057 (làm rõ ranh giới role trước) | S | Manifest fixture cho cả 4 role (Builder/Reviewer/Sprint Lead/Architecture Manager); `$ref` đúng tới `$defs/ai_capability_scopes`, không nhân đôi enum; không có fixture cho Project Owner; `validate:schemas` xanh, báo số liệu thật | Chưa bắt đầu |
| NF-059 | Viết lại 4 field artifact hard-code trong `rules/forge-sprint-delivery.rules.json` (`WF-002/003/005/006`) — map sang schema Nodeforge thật đã có, **giữ nguyên intent + severity + enforcement** của từng rule, chỉ đổi field tham chiếu artifact (xem bảng map đề xuất ở `ARCHITECTURE.md` mục 66.5). Không đổi 4 rule còn lại (WF-001/004/007/008 không hard-code artifact sai) | `rules/forge-sprint-delivery.rules.json` | — (data fix, không cần Rule Engine tồn tại) | S | 4 rule sửa xong không còn field nào trỏ tới `status.json`/`COMMIT.md`/`builder-report.md`/`review.md`; validate file này qua đúng `project/workflow-ruleset.schema.json` đã có; báo cáo rõ field cũ → field mới cho từng rule | Chưa bắt đầu |

**Lưu ý khi giao cho Builder:** NF-059 độc lập, làm ngay. NF-057 làm trước (định nghĩa ranh
giới role), NF-058 làm sau NF-057 (cần biết rõ Builder/Reviewer khác Project Owner/Sprint
Lead thế nào trước khi giới hạn phạm vi manifest) — không còn hoàn toàn song song như dự kiến
ban đầu.




**Đề xuất bắt đầu ngay (bản gốc):** NF-001 (chặn mọi ticket khác) → sau đó chạy song song
NF-002...NF-009 (schema) với NF-010/NF-011 (shared/bootstrap).

**Đề xuất cho phần mở lại (NF-028–037, NF-013b):** NF-028...NF-033 chạy song song ngay (chỉ
phụ thuộc NF-002, đã Done) → NF-034 (cần NF-033) → NF-035 (cần NF-034) → NF-036 + NF-037
song song → NF-013b tổng hợp cuối cùng.

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
NF-007, NF-003, NF-005, NF-006 (Sprint 0, Done)
NF-044 (Session module, Sprint 2, Done)
NF-023 (internalBus, Sprint 1, Done)
   │
   ├─▶ NF-047 (review baseline event/command enum vs mục 40 — có gap không?)
   │        │
   │        ▼
   │      NF-047b (nếu có gap: bổ sung type còn thiếu)
   │        │
   │        ▼
   ├─▶ NF-048 (Agent process module: spawn, wire format — quyết định thiết kế)
   │        │
   │        ▼
   │      NF-049 (Session linkage: sessions.start/sessions.finish ↔ session-store.js)
   │        │
   │        ├─▶ NF-050 (Request/Event identity + idempotency MVP)
   │        ├─▶ NF-051 (Stream stdout/stderr → internalBus)
   │        ├─▶ NF-052 (Timeout/kill cơ bản)
   │        └─▶ NF-053 (Capability declaration lúc sessions.start)
   │                 │
   │                 ▼
   │       NF-049+050+051+052+053 hội tụ ──▶ NF-054 (integration test end-to-end)
   │                                                  │
   └─▶ NF-055 (Concurrent modification — nhận diện, MVP) ─┘
                                                            │
                                                            ▼
                                                  NF-056 (exit check tổng hợp)
```

### Backlog

| ID | Ticket | Thư mục | Phụ thuộc | Est. | Acceptance criteria | Trạng thái |
|---|---|---|---|---|---|---|
| NF-047 | Review baseline `core/event.schema.json`/`core/command.schema.json` (Sprint 0) đối chiếu đúng 12 verb ở mục 40 (`sessions.start/context.request/task.status/test.request/review.request/sessions.finish` là Command; `context.ready/file.changed/test.started/test.finished/review.requested/workflow.changed` là Event). Không sửa nếu đã đúng, chỉ báo cáo gap cụ thể (verb nào thiếu, tên khác gì) | `schemas/core/` (review only) | NF-005, NF-006 | S | Báo cáo dứt khoát 12/12 verb: có trong enum hay thiếu, tên khớp hay lệch convention `domain.action` | ✅ Done — 8/12 có tương đương (tên lệch, chấp nhận không đổi — xem quyết định NF-047b); 4/12 thiếu thật: `context.request`, `task.status`, `test.started`, `review.requested` |
| NF-047b | Bổ sung đúng 4 type còn thiếu thật (không đổi tên 8 type đã có). **Tên đã chốt (không để Builder tự đặt):** Command `context.request`, Command `tasks.report_status` (domain số nhiều khớp `tasks.start`/`tasks.cancel` đã có), Event `verification.test_started` (khớp domain `verification.test_completed` đã có), Event `review.requested` (phân biệt với `review.started` đã có — đánh dấu lúc request được nhận, không phải lúc Reviewer bắt đầu làm) | `schemas/core/` | NF-047 | S | 4 type mới thêm đúng tên đã chốt; `validate:schemas` vẫn xanh; thêm fixture cho từng type mới; **không đổi bất kỳ type nào trong 8 type đã có** | ✅ Done — 2 Command vào `command.schema.json`, 2 Event vào `event.schema.json` + `node-event.schema.json` (đúng hướng Node→Agent); `node-command.schema.json` không cần sửa (Agent→Node, ngoài phạm vi Node phát). 34→38 fixture, 33 schema không đổi. 55/55 test |
| NF-048 | Agent process module (`src/modules/agents/`): spawn Agent như child process độc lập (provider-neutral — không biết bên trong là Codex/Claude/local LLM). **Quyết định thiết kế (đã chốt, không để Builder tự chọn):** wire format là newline-delimited JSON qua stdin (Node→Agent, Command) và stdout (Agent→Node, Command ngược + Event thông báo), mỗi dòng là 1 object khớp `core/envelope.schema.json`; stderr **không** parse structured, chỉ log thô | `src/modules/agents/` | NF-047 (hoặc NF-047b) | M | Spawn 1 script giả lập (fixture, không phải AI thật) → gửi được 1 Command qua stdin, nhận đúng 1 Event qua stdout, cả 2 đều validate qua Ajv với `core/envelope.schema.json` | ✅ Done — `agent-process.js`, ghép stdout theo newline trước khi parse (test riêng cho case JSON bị chia 2 chunk), stderr raw qua event riêng. 56/56 test |
| NF-049 | Session linkage: `sessions.start` (Command từ Agent) → Node tạo/liên kết `session_id` qua `session-store.js` (NF-044, Sprint 2) — dùng field `agents: string[]` đã có sẵn, KHÔNG đổi schema. `sessions.finish` → đóng session | `src/modules/agents/`, `src/modules/projects/` | NF-048, NF-044 | S | `sessions.start` → session record có `agents` chứa đúng agent id; `sessions.finish` → session đóng, dữ liệu vẫn còn (đọc lại được, đúng hành vi NF-044 đã kiểm) | ✅ Done — `agent-session-link.js`, `sessions.stop` fallback theo agent hoặc `session_id`, test qua agent fixture thật (NDJSON), 57/57 test |
| NF-050 | Request/Event identity + idempotency MVP (mục 41/42): mọi Command từ Agent phải có `request_id` (dùng `$defs.id` có sẵn từ `common.schema.json`, không tạo field mới). Node lưu `request_id` đã xử lý trong phạm vi 1 session (in-memory Map hoặc bảng SQLite riêng — Builder chọn, báo lại lý do); nhận trùng `request_id` cho request cần idempotent (`verification.run_test` — tên thật đã xác nhận ở NF-047, không phải `test.request`) → trả lại kết quả cũ, không chạy lại | `src/modules/agents/` | NF-049 | M | Gửi `verification.run_test` với cùng `request_id` 2 lần → chỉ 1 lần xử lý thật, lần 2 trả cached result; khác `request_id` → xử lý bình thường. **MVP — không cần persist qua restart Node (đó là Sprint 9 crash recovery)** | ✅ Done — `Map<session_id, Map<request_id, result>>` in-memory; từ chối request thiếu `request_id`/`session_id`; test qua agent fixture thật. 58/58 test |
| NF-051 | Agent stream → `internalBus` (mục 29, phạm vi thu hẹp — xem `ARCHITECTURE_SPRINT3.md`): capture stdout (đã parse structured ở NF-048) + stderr (raw text) theo thời gian thực, publish lên `internalBus` đã có từ Sprint 1 (NF-023) — **không** tạo Event Store thật, **không** làm WebSocket/UI (đó là Sprint 8) | `src/modules/agents/`, `src/bootstrap/` | NF-048, NF-023 (Sprint 1, Done) | S | Agent fixture in ra 5 dòng stdout → `internalBus` nhận đúng 5 message theo đúng thứ tự, không rớt, không trộn lẫn với event của watcher/index | ✅ Done — channel `agent.stream` riêng (`agent.stdout`/`agent.stderr`), tách biệt hoàn toàn kênh watcher/index. 59/59 test |
| NF-052 | Timeout/kill cơ bản (mục 44, phạm vi thu hẹp): Node set timeout khi spawn Agent (config được); vượt ngưỡng → kill process, phát **`agent.error`** (payload có `reason: "timeout"`) rồi **`agent.stopped`** — dùng lại 2 type đã có sẵn trong enum `agents` domain, **không thêm type mới** | `src/modules/agents/` | NF-048 | S | Agent fixture chạy quá timeout (giả lập bằng `sleep`) → Node kill đúng lúc, phát đúng thứ tự `agent.error`(reason=timeout) → `agent.stopped`, process không còn zombie (kiểm bằng PID) | ✅ Done — SIGTERM→SIGKILL với `terminateGraceMs` cấu hình được; đúng enum `agents.error`/`agents.stopped`; PID xác nhận biến mất (ESRCH). 60/60 test |
| NF-053b | Thêm `capability_scopes` (optional) vào `project/session.schema.json`, validate qua `oneOf` tới `core/agent.schema.json#/$defs/ai_capability_scopes` + `.../node_capability_scopes` — **không** định nghĩa lại shape (gap phát hiện khi Builder review trước NF-053, đúng quy trình đã dùng ở NF-039). Quyết định đã chốt: optional ở schema (Session record có thể tạo qua đường nội bộ/khôi phục, không chỉ Agent Protocol), bắt buộc ở tầng nghiệp vụ (handler `sessions.start`) | `schemas/project/session.schema.json` | NF-007 (Sprint 0, Done) | S | Fixture AI/Node profile hợp lệ → pass; không có field → vẫn pass (optional); sai shape (không khớp 2 `$defs`) → reject; `validate:schemas` số liệu thật; grep xác nhận không có code/schema nào khác giả định thiếu field này | ✅ Done — field tại `session.schema.json:55`, `oneOf` trực tiếp tới 2 profile `agent.schema.json` (không định nghĩa lại shape); `session-store.js:11` chỉ sửa để nạp `agent.schema.json` cho AJV resolve `$ref`, không đổi persistence/behavior khác. 2 test mới: `accepts AI and Node session capability profiles while keeping the field optional`, `rejects a session capability declaration that matches neither Agent profile`. Xác nhận test cũ NF-044 (`creates a schema-valid session...`, `rejects session records that violate...`) vẫn nguyên, không bị ảnh hưởng bởi việc sửa `session-store.js`. `validate:schemas`: 33 schema (không đổi)/41 fixture (+3). 62/62 test, lint/typecheck/`git diff --check` pass |
| NF-053 | Capability declaration lúc `sessions.start` (tên thật, không phải `session.start`): Agent gửi kèm `capability_scopes` (đúng shape `core/agent.schema.json`, NF-007) trong payload, Node validate qua Ajv rồi lưu vào session record. **Trước khi code:** kiểm tra `project/session.schema.json` (NF-039, Sprint 2) đã có field chứa capability chưa — nếu chưa, báo lại trước khi tự ý thêm field (đúng nguyên tắc review-trước-khi-sửa đã dùng ở NF-039/039b Sprint 2, không tự quyết một mình). **CHƯA enforce permission thật** (Rule Engine — Sprint 5), chỉ lưu để dùng sau | `src/modules/agents/` | NF-049, NF-007 (Sprint 0, Done), NF-053b (Done) | S | `sessions.start` thiếu `capability_scopes` hoặc sai shape → reject (Ajv), không tạo session; đúng shape → lưu nguyên vào session record; nếu cần sửa `session.schema.json`, báo cáo rõ trước khi sửa | ✅ Done — `agent-session-link.js:12` validate `capability_scopes` qua đúng 2 `$defs` AI/Node trước khi tạo Session; thiếu/sai shape → `protocol_error`, không gọi `sessionStore.create()`. Hợp lệ → lưu nguyên qua `session-store.js:35`, comment rõ *"capability declared, not yet enforced"*. **Tự phát hiện + xoá scope creep:** ban đầu có phát thêm event `capability_declared` (tự đặt, không có trong `core/event.schema.json`/`node-event.schema.json`/`internalBus`) — đã tự xoá trước khi báo cáo cuối, giữ đúng phạm vi ticket. 3 test mới: `rejects sessions.start without capability_scopes...`, `rejects sessions.start with capability_scopes outside both Agent profiles...`, `stores a Node capability profile unchanged without enforcing it`; coverage AI profile nằm trong test đã có sẵn từ NF-049 (mở rộng assertion, không tạo test trùng). 65/65 (62+3, khớp đúng số học). Gate: lint/typecheck/`validate:schemas` (33/41)/`git diff --check` đều pass |
| NF-054 | Integration test end-to-end — **2 luồng, không chỉ 1 (bổ sung sau đối chiếu mục 66.8):** (a) luồng Builder — Agent fixture `sessions.start` (kèm capability) → ghi file thật vào project fixture → Node watcher thấy (tái dùng pipeline Sprint 1 nguyên vẹn, không sửa) → `sessions.finish`; (b) luồng Reviewer — Agent fixture khác đọc file Builder vừa ghi (qua Code Index, không viết file trung gian) → gửi verdict về Node dưới dạng Command/Event có cấu trúc (không tạo file `review.md` hay tương đương). Xác nhận toàn chuỗi thật, đo được, không mock ở tầng nào | `tests/integration/` | NF-049, NF-050, NF-051, NF-052, NF-053 | M | Luồng (a): session tạo đúng, file được index (kiểm `index.db`), stream có đủ log, session đóng sạch — không leak process/handle; **luồng (b) mới:** Reviewer fixture nhận đúng nội dung file qua Code Index (không phải file trung gian tự chế), verdict tới Node dưới dạng Event có cấu trúc, `git status`/filesystem xác nhận **không có file `review.md` hay bất kỳ file "handoff" nào** được tạo ra trong quá trình này | ⚪ Backlog |
| NF-055 | Concurrent modification — nhận diện MVP (mục 45, phạm vi thu hẹp): ghi nhận file nào đang được task/session hiện tại "động vào" (đơn giản: bảng ánh xạ `session_id → path[]` trong SQLite, cập nhật khi Agent ghi file qua watcher event). 2 session khác nhau cùng lúc động vào 1 file → Node phát warning Event, **không khoá file vật lý, không throw, không chặn ghi** | `src/modules/agents/` | NF-049 | S | 2 fixture agent (2 session khác nhau) cùng ghi 1 file trong cửa sổ ngắn → Node phát đúng 1 warning Event, cả 2 lần ghi vẫn thành công (không bị chặn) | ⚪ Backlog |
| NF-056 | Exit check Sprint 3 tổng hợp | Tất cả trên | — | S | `npm test` xanh 100%, `npm run lint`, `npm run typecheck`, `npm run validate:schemas`, `npm run bootstrap:smoke`, `git diff --check` đều xanh — đúng format Gate đã dùng từ Sprint 0 | ⚪ Backlog |

**Ước tính:** S=nhỏ, M=vừa, L=lớn.

### Rủi ro cần Builder lưu ý khi code

| Rủi ro | Ảnh hưởng | Hướng xử lý đề xuất |
|---|---|---|
| NF-048 tự ý đổi wire format (vd. dùng length-prefixed thay vì newline-delimited) mà không báo | Sprint 8 (Transport thật qua WebSocket/API) phải viết lại adapter parse | Wire format đã chốt cứng trong ticket — nếu Builder thấy cần đổi, phải báo lại trước khi code, không tự quyết như đã cho phép ở `external`/`capability_scope` trước đây (lần này quyết định đã có sẵn) |
| `internalBus` (NF-051) bị dùng làm nơi lưu trữ lâu dài thay vì chỉ pass-through | Lặp lại đúng rủi ro đã ghi từ Sprint 1: "`internalBus` dễ bị lạm dụng thành Event Store tạm thời" | Nhắc lại rào chắn cũ: `internalBus` không export ra `src/application/`/`src/transport/`, chỉ nội bộ `src/bootstrap/` |
| NF-050 idempotency MVP dễ bị hiểu nhầm là đã "chống crash" hoàn chỉnh | Sprint 9 tưởng nhầm việc này đã xong, bỏ sót khi làm crash recovery thật | Ghi rõ trong Definition of Done: MVP không persist qua restart Node — đây là giới hạn cố ý, không phải thiếu sót |
| Agent fixture (script giả lập) khác hành vi Agent AI thật quá nhiều (vd. không bao giờ ghi file lỗi cú pháp, không bao giờ timeout thật) | NF-054 pass nhưng không phản ánh rủi ro thật khi có AI thật cắm vào (Sprint 8+) | Fixture nên cố tình có ít nhất 1 kịch bản "xấu" (ghi file dở dang, hoặc chạy quá timeout) để NF-052/debounce Sprint 1 được test chung, không chỉ happy path |
| NF-053 lưu `capability_scopes` nhưng chưa enforce — dễ tạo cảm giác an toàn giả | Task/Rule Engine (Sprint 5) enforce sai nếu tưởng nhầm Sprint 3 đã chặn theo capability | Ghi rõ trong session record hoặc log: "capability declared, not yet enforced" — tránh nhầm lẫn khi review Sprint 5 |

### Exit criteria

- [ ] NF-047(b): enum Command/Event khớp đủ 12 verb mục 40, không có gap ẩn
- [ ] NF-054: agent fixture chạy hết chuỗi sessions.start → ghi file → index cập nhật → sessions.finish, đo được, không mock
- [ ] check-result (lint/typecheck) PASS cho toàn bộ code Sprint 3
- [ ] NF-056 tổng hợp: toàn bộ gate xanh (test/lint/typecheck/schema/smoke/diff-check)

### Đề xuất thứ tự giao việc

1. **Ngay:** NF-047 (rủi ro cao nhất nếu bỏ qua — đúng bài học NF-039 ở Sprint 2: review trước,
   đừng giả định baseline đã đủ).
2. **Sau đó:** NF-047b (nếu có gap) → NF-048 (nền tảng cho cả nhánh còn lại).
3. **Song song sau NF-048+NF-049:** NF-050, NF-051, NF-052, NF-053 — 4 nhánh độc lập, không phụ
   thuộc lẫn nhau, chỉ cùng phụ thuộc NF-049.
4. **Riêng:** NF-055 chỉ cần NF-049, có thể làm song song với nhóm trên.
5. **Hội tụ:** NF-054 (integration, cần cả 5 nhánh) → NF-056 (exit check).

---

## Sprint 4 — Verification (Test/Build/Lint/Typecheck)

**Mục tiêu:** Node "chạy verification chính thức" — không để AI tự claim là đã pass.

> `schemas/verification/*` (plan/run/result/test-failure/policy) đã được tạo ở Sprint 0
> (NF-028–032, sau khi mở lại). Sprint 4 **không tạo lại** các schema này — chỉ implement
> runner thật đọc `verification-plan`, ghi `verification-run`/`verification-result`, và tạo
> mới 2 schema `results/` dưới đây mà `verification-run.result_ref` sẽ trỏ tới.

| Việc | Thư mục | Ghi chú |
|---|---|---|
| Test runner | `src/modules/verification/` | `results/test-result.schema.json`: pass/fail count + từng failure |
| Build/Lint/Typecheck runner (gộp chung) | `src/modules/verification/` | `results/check-result.schema.json` (mới): field `kind` phân biệt 3 loại thay vì 3 schema gần giống nhau |
| Git change set / diff | `src/modules/git/` | dùng ở Sprint 5 cho Reviewer |

**Exit:** chạy test/lint/typecheck thật trên project mẫu, kết quả map đúng vào
`check-result`/`test-result`, diagnostic có file/dòng/cột/rule_id; `verification-result`
(NF-030) phản ánh đúng gate `ready_for_review`.

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

## Sprint 6 — "Anvil-Chorus" (Workflow Engine)

> Tên mã: **Anvil-Chorus** — nhiều tiếng búa (Builder/Reviewer/Sprint Leader) gõ theo đúng
> nhịp 1 bản nhạc chung (state machine), không tự ý gõ lệch nhịp. Tài liệu tham khảo:
> `ARCHITECTURE.md` mục 51 (flow Builder→Test→Reviewer), mục 55 (source of truth), mục
> 63.1–63.2 (Commit↔Task, PLAN/STATE), mục 66.1/66.5/66.7/66.8 (quyết định đã chốt khi đối
> chiếu `FORGE_WORKFLOW_v2.md`).

**Mục tiêu:** đồ thị trạng thái cho Task/Commit — Node kiểm tra rule (Sprint 5) + transition
hợp lệ trước khi ghi state, không hard-code control flow bằng if/else (STRUCTURE.md
"Boundaries": `rules/`+`workflows/` là data validate theo schema, không phải logic cứng).

> **3 quyết định đã chốt từ trước, bắt buộc tuân theo — không tự ý làm khác:**
> 1. **`status.json` = `.forge/runtime/state.json`** (mục 66.1) — không tạo file mới, dùng
>    đúng file đã build ở Sprint 2. Bảng nháp cũ còn ghi "trước khi ghi `status.json`" — đã
>    sửa thành `state.json` trong bảng dưới.
> 2. **`rules/forge-sprint-delivery.rules.json` cần vá trước khi engine đọc nó** (mục 66.5,
>    ticket NF-059 — Sprint 0 mở lại lần 2, có thể đang chạy song song) — 4/8 rule
>    (`WF-002/003/005/006`) hard-code artifact sai (`status.json`/`COMMIT.md`/
>    `builder-report.md`/`review.md` kiểu cũ). **Không code Workflow Engine đọc ruleset này
>    trước khi xác nhận NF-059 đã Done** — nếu chưa, Workflow Engine sẽ tự khoá cứng mọi
>    Commit ngay từ đầu.
> 3. **Kết quả luôn qua Node, không có kênh Agent↔Agent/Agent↔Owner trực tiếp** (mục 66.7–66.8)
>    — Reviewer trả verdict qua Event có cấu trúc (`review-result`), không viết file trung
>    gian. Owner Gate (`WF-008`) là nơi Workflow Engine tạm dừng transition, chờ quyết định
>    Project Owner đi qua Node → Transport (Sprint 8) → người, không tự mở kênh riêng.

### Bảng phụ thuộc trong-sprint

```
NF-059 (vá rules/forge-sprint-delivery.rules.json — CHẶN, phải Done trước)
Sprint 5 (Rule Engine — CHẶN, phải tồn tại để đọc ruleset)
Sprint 3 (Agent Protocol — Done, tái dùng cho Reviewer verdict + Sprint Leader loop)
   │
   ├─▶ NF-070 (review baseline workflow.schema.json + workflows/forge-sprint-delivery.workflow.json)
   │        │
   │        ▼
   │      NF-071 (State-machine executor core: đọc workflow.states tự do, không hard-code)
   │        │
   │        ├─▶ NF-072 (Transition gate: check rule trước khi ghi state.json)
   │        ├─▶ NF-073 (Flow Builder→Test→Reviewer, theo mục 51)
   │        ├─▶ NF-074 (Owner Gate: WF-008, tạm dừng chờ Project Owner)
   │        └─▶ NF-075 (Node↔Sprint Leader loop: yêu cầu Sprint mới khi hoàn tất, mục 66.8)
   │                 │
   │                 ▼
   │       NF-072+063+064+065 hội tụ ──▶ NF-076 (integration test: 1 task chạy hết vòng thật)
   │                                                │
   └────────────────────────────────────────────────▼
                                              NF-077 (exit check tổng hợp)
```

### Backlog

| ID | Ticket | Thư mục | Phụ thuộc | Est. | Acceptance criteria | Trạng thái |
|---|---|---|---|---|---|---|
| NF-070 | Review baseline `project/workflow.schema.json` (đã có, xác nhận `states` là mảng string tự do — không hard-code enum trạng thái) + `workflows/forge-sprint-delivery.workflow.json` (đồ thị trạng thái mặc định, README nhắc tới nhưng chưa từng được đọc kỹ trong hội thoại này). Không sửa nếu đã đúng, chỉ báo cáo gap | `schemas/project/`, `workflows/` (review only) | NF-013-CLOSE | S | Báo cáo dứt khoát: đồ thị trạng thái trong file có khớp flow mục 51 (`PLANNED→IN_PROGRESS→READY_FOR_REVIEW→REVIEWING→APPROVED/BLOCKED`, tên state có thể khác nhưng ý nghĩa phải đủ) không; nếu thiếu state/transition nào, liệt kê path:line cụ thể | Chưa bắt đầu |
| NF-071 | State-machine executor core (`src/modules/workflows/`): đọc `workflow.states` (tự do theo từng workflow), thực thi transition — **không** hard-code if/else theo tên state cụ thể nào (đúng nguyên tắc STRUCTURE.md) | `src/modules/workflows/` | NF-070 | L | Nạp `workflows/forge-sprint-delivery.workflow.json` → executor chạy đúng theo state graph trong file, không có logic gắn cứng tên state trong code; đổi tên 1 state trong file → executor vẫn chạy đúng không cần sửa code | Chưa bắt đầu |
| NF-072 | Transition gate: trước khi ghi `state.json` (đúng tên đã chốt mục 66.1, KHÔNG phải `status.json`), kiểm tra qua Rule Engine (Sprint 5) — actor được phép chuyển trạng thái, artifact bắt buộc, dependency gate, allowlist thay đổi, bằng chứng test (đúng `WF-001`→`007` sau khi NF-059 vá xong) | `src/modules/workflows/` | NF-071, NF-059 (Done — ruleset đã vá), Sprint 5 (Rule Engine tồn tại) | M | Transition vi phạm rule (vd. Reviewer thử tự chuyển sang `APPROVED` không qua đủ điều kiện `WF-006`) → bị chặn, `state.json` không đổi; transition hợp lệ → ghi đúng | Chưa bắt đầu |
| NF-073 | Flow Builder→Test→Reviewer (mục 51): Task → Builder code → Node Watcher (Sprint 1) → Node Test Runner (Sprint 4) → FAIL quay lại Builder / PASS → Reviewer → APPROVE hoặc CHANGES quay lại Builder. Reviewer trả verdict qua Event có cấu trúc (`results/review-result.schema.json`, đã có) — **không viết file trung gian** (đúng mục 66.7–66.8) | `src/modules/workflows/` | NF-071, Sprint 3 (Agent Protocol, Done), Sprint 4 (Verification, chưa bắt đầu — có thể cần chờ) | L | Task giả lập chạy hết vòng: Builder ghi file lỗi → Test FAIL → quay lại Builder; Builder sửa đúng → Test PASS → Reviewer nhận diff → CHANGES 1 lần → Builder sửa → APPROVE; xác nhận không có file `review.md`/tương đương nào được tạo trong suốt quá trình | Chưa bắt đầu |
| NF-074 | Owner Gate (`WF-008`, mục 66.8): phát hiện thay đổi thuộc nhóm cần Project Owner duyệt (scope/architecture/API/dependency/acceptance-criteria) → **tạm dừng** transition, phát Event yêu cầu quyết định, chờ phản hồi qua Node (kênh Transport thật là Sprint 8 — Sprint 6 chỉ cần cơ chế tạm dừng + chờ, không tự dựng UI) | `src/modules/workflows/` | NF-072 | M | Transition thuộc 5 nhóm `WF-008` → workflow dừng ở trạng thái chờ, không tự tiến; giả lập Node nhận phản hồi (mock, vì Transport chưa có) → workflow tiếp tục đúng | Chưa bắt đầu |
| NF-075 | Node↔Sprint Leader loop (mục 66.8): thêm đúng 1 cặp Command/Event mới vào Agent Protocol vocabulary (domain nối tiếp `sprints.*`, tên chốt trước khi code — đúng quy trình NF-047b) cho "yêu cầu lập Sprint mới"/"trả kế hoạch Sprint mới". Payload Event validate qua `roadmap/sprint.schema.json`+`commit.schema.json` đã có (NF-033–035, không tạo schema mới) | `src/modules/agents/`, `src/modules/workflows/` | NF-071, Sprint 3 (Agent Protocol, Done) | M | Sprint hiện tại đạt trạng thái hoàn tất → Node tự phát Command yêu cầu Sprint Leader (fixture) → nhận Event có payload đúng shape `sprint.schema.json` → validate pass | Chưa bắt đầu |
| NF-076 | Integration test: 1 task chạy hết vòng thật qua Workflow Engine (exit criteria gốc) | `tests/integration/` | NF-072, NF-073, NF-074, NF-075 | M | Task thật → Builder → Test → Reviewer → Approve, mọi transition đều qua rule check trước khi ghi `state.json`, đo được, không mock tầng nào ngoài Agent fixture | Chưa bắt đầu |
| NF-077 | Exit check Sprint 6: tổng hợp toàn bộ | Tất cả trên | — | S | `npm test` xanh 100%, lint/typecheck/`validate:schemas`/`git diff --check` đều xanh — đúng format Gate đã dùng từ Sprint 0; rà soát rủi ro mang từ Sprint 1-5 còn hiệu lực không | Chưa bắt đầu |

**Ước tính:** S=nhỏ, M=vừa, L=lớn.

### Rủi ro cần lưu ý

| Rủi ro | Ảnh hưởng | Hướng xử lý đề xuất |
|---|---|---|
| NF-072 code trước khi xác nhận NF-059 (vá ruleset) đã Done thật | Workflow Engine tự khoá cứng mọi Commit ngay từ ticket đầu tiên (đúng rủi ro đã cảnh báo ở mục 66.5) | Bắt buộc kiểm tra trạng thái NF-059 trước khi giao NF-072, không giả định |
| NF-073 phụ thuộc Sprint 4 (Verification) chưa bắt đầu | Không có Test Runner thật để chạy flow PASS/FAIL | Cân nhắc thứ tự: có thể cần làm Sprint 4 trước hoặc song song, không phải tuần tự cứng 4→5→6 như số thứ tự gợi ý |
| NF-074 (Owner Gate) cần "chờ phản hồi" nhưng Transport (Sprint 8) chưa có kênh UI thật | Chỉ test được bằng mock, chưa xác nhận hành vi thật khi có người dùng thật ở đầu kia | Chấp nhận ở Sprint 6, ghi rõ giới hạn — test thật với UI để dành Sprint 8 |
| NF-075 thêm Command/Event mới — nếu đặt tên tuỳ tiện, lặp lỗi đã sửa ở NF-047b | Domain/casing không nhất quán, phải sửa lại sau | Chốt tên trước khi code, theo đúng domain đã có (`sprints.*`), không tự đặt |
| State-machine executor (NF-071) bị hard-code ngầm theo tên state cụ thể dù không cố ý | Vi phạm nguyên tắc STRUCTURE.md, đổi workflow file không hoạt động đúng | Test bắt buộc: đổi tên state trong file rồi chạy lại, không sửa code, vẫn phải đúng |

### Exit criteria

- [ ] NF-076: 1 task chạy hết vòng Builder → Test → Reviewer → Approve qua workflow thật
- [ ] Mọi transition được kiểm tra rule trước khi ghi `state.json` (không phải `status.json`)
- [ ] NF-077 tổng hợp: toàn bộ gate xanh

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

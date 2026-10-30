<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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

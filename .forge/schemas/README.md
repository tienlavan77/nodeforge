# Forge Schema v1.3

Agent request/response envelopes in `schemas/agent/agent-request.schema.json` and
`schemas/agent/agent-response.schema.json` use v1.3. Stable context is isolated from
step-specific dynamic context; when `cache_enabled` is true, Node marks the stable
block with Anthropic `cache_control: { type: "ephemeral" }`. Cache usage is reported
from the provider response and is never treated as agent content.

ChatGPT Responses API uses the provider-specific `agent-request-oai.schema.json` and
`agent-response-oai.schema.json` contracts. OpenAI adapters map cacheable developer
blocks to `prompt_cache_breakpoint`, pass the explicit cache key/TTL, and normalize
cached usage to `usage.cached_tokens`.

Bộ contract chuẩn hóa cho Forge theo mô hình **Node cũng là một System Agent**.

Xem `CHANGELOG.md` để biết chi tiết từng thay đổi so với v1.1 và lý do.

## Cấu trúc

```text
schemas/
├── core/         # Envelope, Agent, Event, Command, Error, Common — dùng chung toàn hệ thống
├── node/         # Profile của core dành riêng cho Node (subset enum + capability + state)
├── project/      # Project, Task, Rule, Permission, Workflow, Workflow Rule, Session
├── context/      # Context Pack (Token Firewall)
├── results/      # Test Result, Check Result (build/lint/typecheck), Review Result, File Change
├── verification/ # Node verification orchestration: plan, run, result, failure, policy
└── roadmap/      # Commit-able PLAN: roadmap, sprint, commit; no runtime state
```

## Nguyên tắc quan trọng nhất của bản v1.2: một enum, không nhân đôi

Ở v1.1, `core/event.schema.json` và `node/node-event.schema.json` (tương tự với `command`)
định nghĩa `type` enum **độc lập nhau** — dễ lệch dần theo thời gian. Từ v1.2:

- `core/event.schema.json` và `core/command.schema.json` là **nguồn sự thật duy nhất** cho toàn
  bộ danh sách `type` hợp lệ trong hệ thống.
- `node/node-event.schema.json` và `node/node-command.schema.json` không tự định nghĩa enum nữa.
  Chúng dùng `allOf` để **tham chiếu + thu hẹp** schema core, tức là: mọi node-event/node-command
  hợp lệ chắc chắn cũng hợp lệ theo core, nhưng bị giới hạn xuống tập con những `type` mà tầng
  Node-nội-bộ được phép phát ra. Không còn hai danh sách phải giữ đồng bộ thủ công.

## Task.status vs Workflow.states — cố ý tách biệt

- `workflow.schema.json.states` là mảng string **tự do**, do từng workflow tự định nghĩa
  (đúng nguyên tắc "không hard-code workflow bằng if/else").
- `task.schema.json.status` là một enum **cố định, thô, không phụ thuộc workflow**
  (`pending / active / blocked / completed / failed / cancelled`) — chỉ trả lời "tác vụ này còn
  sống hay đã xong", không trả lời "đang ở bước nào trong pipeline".
- Vị trí chi tiết trong pipeline nằm ở `task.workflow_state` (string tự do, khớp với
  `workflow.states` của `task.workflow_id`).

Hai field này **không suy ra lẫn nhau** và không nên đồng bộ tự động — `status` là bucket tổng
quát Node dùng để lọc/dashboard nhanh, `workflow_state` là sự thật chi tiết cho engine.

## Context compression

Không minify code để tiết kiệm token.

```text
Code Index
  ↓
symbol selection
  ↓
dependency selection
  ↓
line-range selection
  ↓
deduplication
  ↓
structural/history/test summary
  ↓
Context Pack
  ↓
Builder / Reviewer
```

Context Pack giờ mang thêm `index_version` + `generated_at` để Builder/Reviewer biết pack này
được build trên snapshot Code Index nào — tránh dùng context đã stale nếu index cập nhật ngay sau
khi pack được tạo.

Nguyên tắc:

> Context nhỏ nhất nhưng vẫn đủ để AI suy luận chính xác.

## Agent model

```text
System Agent
└── Node / Orchestrator

AI Agents
├── Builder
├── Reviewer
├── Planner
└── Tester
```

Node là system agent: deterministic, orchestration/verification, không phải AI reasoning agent.

Cả hai loại agent giờ có thể khai báo capability theo cấu trúc nhóm (`capability_scopes`,
`common.schema.json#/$defs/capability_scope`) — trước đây chỉ Node có, AI agent chỉ có mảng
string phẳng (`capabilities`), gây lệch mức chi tiết giữa hai loại. Mỗi group chứa các grant có
shape `{ "resource": "…", "actions": ["…"] }`; `actions` không rỗng và không được trùng,
grant không nhận thêm field nào. Đây chỉ là capability declaration: quyền path/ACL vẫn thuộc
duy nhất về `project/permission.schema.json`. Vocabulary cụ thể cho Node profile và AI agent
được chốt ở tầng profile, không hard-code trong common schema.

`core/agent.schema.json` là nguồn sự thật duy nhất của capability. `node/node-agent.schema.json`
là profile `allOf` của contract đó; `node/node-capability.schema.json` chỉ còn là schema deprecated
trỏ về profile này và không còn chứa các boolean capability riêng. Với AI, group `agent_events`
chỉ cho phép publish lifecycle/log của `self` và subscribe stream Agent Protocol của chính nó.
Các system event như `watcher.*`, `index.*`, và `workflow.*` là trạng thái tất định do Node phát,
không thể được AI khai báo hoặc phát qua capability này.

## Filesystem, Permission và Rule — hai lớp khác nhau

- **Permission** (`project/permission.schema.json`, mới): trả lời *"hành động này có được phép
  xảy ra không"* — role × path glob × access (read/write/create/delete/rename/execute) ×
  allow/deny × priority. Node đánh giá **tất định**, trước khi hành động chạy.
- **Rule** (`project/rule.schema.json`): trả lời *"thay đổi này có tốt/tuân thủ không"* — thường
  cần phán đoán, do Reviewer (AI) hoặc Node (nếu có `condition` máy đọc được) đánh giá.

Rule giờ có thêm field `condition` + `condition_language` tùy chọn (jsonlogic/regex/glob/
ast_query) để Node có thể tự enforce mà không cần AI, thay vì chỉ dựa vào `rule` dạng văn bản.
`enforcement: "orchestrator"` hoặc `"blocking"` nên luôn đi kèm `condition`.

## Workflow rules cho Node

`project/workflow-rule.schema.json` là contract cho các rule có thể được Node kiểm tra tất định
khi chạy workflow: actor được phép chuyển trạng thái, artifact bắt buộc, dependency gate,
allowlist thay đổi, bằng chứng test và Project Owner gate.

`project/workflow-ruleset.schema.json` đóng gói nhiều workflow rule thành một ruleset versioned.
Ruleset mặc định nằm tại `rules/forge-sprint-delivery.rules.json`; đồ thị trạng thái tương ứng
nằm tại `workflows/forge-sprint-delivery.workflow.json`. Node phải kiểm tra cả rule lẫn transition
trước khi cập nhật `status.json`.

## Session

`project/session.schema.json` (mới) là object chính thức cho một "phiên làm việc" — trước đây
`session_id` được tham chiếu khắp nơi (Agent, Event, Command, Context, Result) nhưng không có
schema nào định nghĩa bản thân Session là gì.

## Verification Results

- `results/test-result.schema.json`: kết quả chạy test — có cấu trúc riêng (pass/fail count,
  từng failure).
- `results/check-result.schema.json` (mới): dùng chung cho **build / lint / typecheck** — ba loại
  này có hình dạng giống nhau (pass/fail + danh sách diagnostic theo file/dòng/cột/rule_id) nên
  gộp một schema với field `kind` phân biệt, thay vì tạo 3 file gần như trùng nhau.
- `results/review-result.schema.json`: kết quả Reviewer, `findings[].severity` giờ dùng chung
  `common.schema.json#/$defs/severity`.

## Verification Orchestration

`verification/` chuẩn hóa pipeline verification do Node sở hữu. `verification-plan` nói Node
phải chạy gì; `verification-run` ghi lịch sử lần chạy và chỉ tham chiếu `results/*` qua
`result_ref`; `verification-result` là gate tổng hợp duy nhất Workflow Engine đọc.
`test-failure` giới hạn `message` và `stack_excerpt` ở 500 ký tự để Builder nhận bằng chứng cần
thiết thay vì raw log. `verification-policy` quy định hành vi retry/dừng của Node. Builder có thể
chạy test hỗ trợ phát triển, nhưng chỉ kết quả Node chạy, chuẩn hóa và ghi theo các contract này
mới được coi là verification chính thức.

## Roadmap Planning

`roadmap/` là tầng PLAN cao hơn runtime Task: `Roadmap -> Sprint -> Commit`. Commit xác định
mục tiêu, phạm vi thay đổi, acceptance criteria và level verification; nó không có `status`, retry
hay review state. Khi dispatcher thực thi một Commit, Node mới tạo đúng một Task runtime, còn
trạng thái lưu dưới `.forge/runtime/`. `verification.levels` dùng chung vocabulary với
`verification-plan`, để plan cấp cao chỉ khai báo mức cần chạy chứ không thay thế run/result.

## `.forge/`

Mỗi project có state riêng, `.forge/` là vùng runtime/config do Node quản lý, watcher phải
ignore vùng runtime để tránh vòng lặp event.

## Version

Bộ này dùng schema version `1.2.0`.

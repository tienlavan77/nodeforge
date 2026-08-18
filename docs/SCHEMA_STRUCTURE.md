# Forge Schema Plan

Tài liệu này mô tả đầy đủ 33 JSON Schema hiện có dưới `schemas/`. Schema file là nguồn sự thật; tài liệu này giải thích ownership, field và relationship.

## 1. Bản đồ tổng thể

```text
core/common -> core/agent, command, event, envelope, error
            -> node/* profile allOf, project/* runtime, context/*, results/*
roadmap/roadmap -> roadmap/sprint -> roadmap/commit -> verification/verification-plan
verification-plan -> verification-run -> results/* by result_ref -> verification-result
```

## Cây Thư Mục Schema

```text
schemas/
├── README.md                         # Quy ước và quyết định schema v1.2
├── CHANGELOG.md                      # Thay đổi contract giữa các version
├── core/                             # Canonical shared contracts
│   ├── common.schema.json            # Primitive/$defs dùng chung
│   ├── agent.schema.json             # System Agent và AI Agent
│   ├── command.schema.json           # Command canonical Agent <-> Node
│   ├── event.schema.json             # Event canonical toàn hệ thống
│   ├── envelope.schema.json          # Wire envelope NDJSON
│   └── error.schema.json             # Error normalized
├── node/                             # Node profile, chỉ narrow core bằng allOf
│   ├── node-agent.schema.json
│   ├── node-capability.schema.json   # Deprecated compatibility profile
│   ├── node-command.schema.json
│   ├── node-event.schema.json
│   ├── node-query-result.schema.json
│   └── node-state.schema.json
├── project/                          # Per-project runtime/config records
│   ├── project.schema.json
│   ├── session.schema.json
│   ├── task.schema.json
│   ├── permission.schema.json
│   ├── rule.schema.json
│   ├── workflow.schema.json
│   ├── workflow-rule.schema.json
│   └── workflow-ruleset.schema.json
├── context/
│   └── context.schema.json           # Context Pack / Token Firewall
├── results/
│   ├── file-change.schema.json
│   ├── test-result.schema.json
│   ├── check-result.schema.json
│   └── review-result.schema.json
├── verification/                     # Node verification orchestration
│   ├── verification-plan.schema.json
│   ├── verification-run.schema.json
│   ├── verification-result.schema.json
│   ├── verification-policy.schema.json
│   └── test-failure.schema.json
├── roadmap/                          # Commit-able PLAN, không phải runtime state
│   ├── roadmap.schema.json
│   ├── sprint.schema.json
│   └── commit.schema.json
└── examples/                         # Fixture Ajv hợp lệ/không hợp lệ
```

| Nhóm | Schema | Vai trò |
| --- | ---: | --- |
| core | 6 | Primitive và Agent Protocol. |
| node | 6 | Node profile/state/query. |
| project | 8 | Project runtime/config. |
| context | 1 | Context Pack. |
| results | 4 | Outcome normalized. |
| verification | 5 | Plan/run/gate/policy/failure. |
| roadmap | 3 | PLAN commit-able. |

Mọi object schema dùng `additionalProperties: false` trừ contract cố ý mở: `metadata`, Event/Command payload và Node query `items`.

## `schemas/core/`

### `common.schema.json`

Shared `$defs`: `id` (string 1-256, chữ/số/`._:-`), `timestamp` (date-time), `version` (semver), `path` (string 1-4096), `metadata` (object mở), `sha256` (64 hex), `severity` (`info|warning|error|critical`), `capability_scope` (group -> grants `{resource, actions[]}`), và `diff` (files/hunks).

### `agent.schema.json`

Required: `id`, `type`, `role`, `project_id`, `status`, `capability_scopes`.

Optional: `session_id`, `task_id`, `provider`, `model`, `pid`, `workspace`, `version`, `started_at`, `finished_at`, `metadata`.

- `type`: `system`, `ai`.
- `role`: `orchestrator`, `builder`, `reviewer`, `planner`, `tester`, `custom`.
- `status`: `starting`, `initializing`, `watching`, `idle`, `running`, `waiting`, `completed`, `failed`, `cancelled`, `timeout`, `degraded`, `recovering`, `draining`, `stopped`.
- Conditional: `system` phải là `orchestrator` và dùng Node capability profile; `ai` dùng AI capability profile.
- Node capability groups: filesystem, shell, context, index, verification, workflow, agents, events. AI groups: filesystem, shell, context, agent_events.

Capability là declaration, không phải permission enforcement; ACL path/action thuộc `project/permission.schema.json`.

### `command.schema.json`

Required: `type`, `request_id`, `project_id`, `payload`. Optional correlation: `session_id`, `task_id`, `agent_id`, `timestamp`.

Canonical `type` enum:

```text
projects.open, projects.close, projects.get_state
sessions.start, sessions.stop, sessions.query
context.request, context.read_file, context.read_symbol, context.read_range, context.search, context.get_callers, context.get_definition, context.get_imports, context.get_diff, context.get_tests, context.build_pack
tasks.start, tasks.cancel, tasks.report_status
verification.run_test, verification.run_check, review.request
index.scan_project, index.rebuild, index.update_file
workflow.start, workflow.transition_state, workflow.assign_task, workflow.pause, workflow.resume, workflow.cancel
agents.spawn, agents.stop, agents.cancel, agents.report_touch
history.query, node.get_status
```

Payload là object mở. Conditional riêng cho `agents.report_touch` buộc `payload.path` theo common path; `session_id` không nằm trong payload vì Node lấy từ process/session linkage.

### `event.schema.json`

Required: `event_id`, `type`, `project_id`, `timestamp`, `payload`. Optional: `session_id`, `task_id`, `agent_id`, `request_id`, `causation_id`, `sequence`, `metadata`.

Canonical domain enum: `node.*`, `projects.*`, `sessions.*`, `tasks.*`, `watcher.*`, `index.*`, `git.*`, `verification.*`, `context.*`, `rules.*`, `workflow.*`, `review.*`, `agents.*`, `history.*`, `process.*`.

`agents.*` gồm `agents.started`, `agents.stopped`, `agents.message_received`, `agents.error`, `agents.concurrent_modification_detected`.

`request_id` liên kết Event trực tiếp với Command; `causation_id` liên kết Event với Event nguồn.

### `envelope.schema.json`

Wire format NDJSON. Required: `protocol_version`, `message_id`, `sender`, `message`, `timestamp`; optional `receiver`, `metadata`.

Sender/receiver có `id`, `type`, `role`. `message` là `oneOf` Command hoặc Event. Mỗi dòng stdin/stdout Agent là một envelope hoàn chỉnh.

### `error.schema.json`

Required: `code`, `message`, `details`. Optional: `severity`, `retryable`, `cause`, `timestamp`. Đây là normalized error payload, không phải raw stderr.

## `schemas/node/`

| Schema | Cấu trúc / ý nghĩa |
| --- | --- |
| `node-agent.schema.json` | `allOf` core Agent; cố định `type: system`, `role: orchestrator`, Node lifecycle status. |
| `node-command.schema.json` | `allOf` core Command; subset command Node được phát. Agent-to-Node `agents.report_touch` không thuộc subset. |
| `node-event.schema.json` | `allOf` core Event; subset Event Node được phát, gồm watcher/index/workflow/agent lifecycle và concurrent modification. |
| `node-capability.schema.json` | Deprecated compatibility contract; capability authority ở core Agent profile. |
| `node-query-result.schema.json` | Required `request_id`, `project_id`, `kind`, `items`; kind `history`, `session`, `state`; optional `total`, `next_cursor`. |
| `node-state.schema.json` | Required `node_id`, `status`, `updated_at`; optional project, active IDs, watcher và index snapshots. |

Node status: `starting`, `initializing`, `watching`, `running`, `degraded`, `recovering`, `draining`, `stopped`, `failed`. Index snapshot: `unknown`, `building`, `ready`, `stale`, `failed`.

## `schemas/project/`

| Schema | Required | Cấu trúc / ý nghĩa |
| --- | --- | --- |
| `project.schema.json` | `project_id`, `name`, `root`, `schema_version` | Project Registry record; optional forge dir/default branch/workflow/language/package manager/watch. `project_id` là identity ổn định, không suy từ path. |
| `session.schema.json` | `id`, `project_id`, `status`, `started_at` | Optional task/workflow/agents/capability/finish/summary. Capability là `oneOf` AI/Node Agent profile. PK là `id`; foreign refs dùng `session_id`. |
| `task.schema.json` | `id`, `project_id`, `type`, `title`, `status`, `created_at` | Optional `commit_id`, dependency, owner, paths, workflow. Status coarse tách biệt `workflow_state`. |
| `workflow.schema.json` | `id`, `name`, `version`, `initial_state`, `states`, `transitions` | Definition state machine; terminal states/metadata optional; state names tự do. |
| `workflow-rule.schema.json` | `id`, `description`, `severity`, `enforcement`, `trigger`, `condition`, `enabled`, `priority` | Deterministic gate condition oneOf: transition, role action, artifact, change area, dependency, test evidence, owner gate. |
| `workflow-ruleset.schema.json` | `ruleset_id`, `version`, `source`, `rules` | Container versioned của Workflow Rule records. |
| `permission.schema.json` | `id`, `role`, `path`, `access`, `effect` | ACL deterministic. Access read/write/create/delete/rename/execute; effect allow/deny. |
| `rule.schema.json` | `id`, `scope`, `type`, `severity`, `rule`, `enabled` | Policy/review rule; optional machine-readable condition, enforcement, paths, exceptions. |

Task type: `feature`, `bugfix`, `refactor`, `test`, `docs`, `maintenance`, `review`, `custom`.

Task status: `pending`, `active`, `blocked`, `completed`, `failed`, `cancelled`.

Session status: `active`, `completed`, `failed`, `cancelled`, `timeout`.

`commit_id` chỉ có khi Commit Dispatcher tạo Task. `capability_scopes` schema-optional cho Session, nhưng `sessions.start` handler bắt buộc field này theo business rule.

## `schemas/context/` và `schemas/results/`

| Schema | Required / ý nghĩa |
| --- | --- |
| `context/context.schema.json` | Required `schema_version`, `project_id`, `task_id`, `purpose`, `compression`, `budget`. Optional session, task, files, symbols, dependencies, diff, index version, tests/rules/history, redactions. Đây là Context Pack, không phải raw codebase dump. |
| `results/file-change.schema.json` | Required `path`, `operation`, `source`, `timestamp`; operation create/modify/delete/rename/move; source agent/human/script/node/git/unknown. |
| `results/test-result.schema.json` | Required `id`, `project_id`, `status`, `exit_code`, `started_at`, `duration_ms`; optional task/session/command/tests/failures/logs. |
| `results/check-result.schema.json` | Required `id`, `project_id`, `kind`, `status`, `started_at`, `duration_ms`; kind build/lint/typecheck; diagnostics có severity/message và optional location. |
| `results/review-result.schema.json` | Required `id`, `project_id`, `task_id`, `status`, `findings`; finding requires id/severity/title/message. |

Test/Check status: `passed`, `failed`, `error`, `skipped`. Review status: `approved`, `changes_requested`, `blocked`, `failed`.

## `schemas/verification/`

| Schema | Required / relationship |
| --- | --- |
| `verification-plan.schema.json` | `commit_id`, `levels`, `checks`; levels non-empty unique `focused`, `related`, `full`; checks `test`, `lint`, `typecheck`, `build` + command. |
| `verification-run.schema.json` | `run_id`, `commit_id`, `level`, `started_at`, `checks`, `status`; check `result_ref` trỏ Result record, không duplicate result payload. |
| `verification-result.schema.json` | `commit_id`, `run_id`, `status`, `ready_for_review`; normalized Workflow gate. |
| `verification-policy.schema.json` | `focused`, `related`, `full`, `max_retries`; mỗi level có required/stop-on-failure. |
| `test-failure.schema.json` | `test_result_id`, `test`, `file`, `message`; optional line/column/error/stack, message và stack <= 500. |

Run status: `passed`, `failed`, `error`, `running`. Per-check status: `passed`, `failed`, `error`, `skipped`. Gate status: `passed`, `failed`, `skipped`, `not_applicable`.

## `schemas/roadmap/`

| Schema | Required / ý nghĩa |
| --- | --- |
| `roadmap.schema.json` | `schema_version`, `roadmap_id`, `project_id`, `version`, `sprints`; root plan versioned. |
| `sprint.schema.json` | `id`, `objective`, `commits`; optional Sprint dependencies. |
| `commit.schema.json` | `id`, `order`, `objective`, `acceptance_criteria`; optional allowed paths, verification levels, Commit dependencies. |

Roadmap/Sprint/Commit là PLAN commit-able, không mang runtime status/retry. Dispatch Commit tạo runtime Task với optional `commit_id`; Verification Plan dùng cùng vocabulary level nhưng không thay Run/Result.

## Ownership và Validation

```text
Project(project_id) -> Task(optional commit_id/workflow) -> Session(id, agents, capability)
Project(project_id) -> Permission, Rule, Workflow, Workflow Ruleset
Agent(project_id, optional session_id/task_id) -> Envelope(Command | Event)
Roadmap -> Sprint -> Commit -> Task -> Verification Plan -> Run -> Result -> Gate
```

1. Core sở hữu Command/Event enum; Node chỉ narrow qua `allOf`, không copy enum.
2. `project_id` là identity; path chỉ là location hiện tại.
3. Permission là ACL; Rule là policy; capability là declaration.
4. `task.status` là coarse runtime state; `workflow_state` là workflow detail.
5. Roadmap là PLAN; Task/Session/Verification Run là runtime records.

`scripts/validate-schemas.mjs` load toàn bộ schema vào Ajv 2020 và validate fixture tại `schemas/examples/`.

```sh
npm run validate:schemas
```

Khi thêm contract: chọn namespace ownership, tái dùng `$ref`/`$defs`, thêm fixture valid và invalid cho invariant quan trọng, đăng ký fixture, rồi chạy schema validation, test, lint, typecheck và `git diff --check`.

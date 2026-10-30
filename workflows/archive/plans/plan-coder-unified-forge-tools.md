<!-- Architecture outcomes for a provider-neutral engineering toolset without expanding Coder authority. -->
# Plan: Bộ Forge tool thống nhất cho Coder và System Engineer

- **Ngày:** 2026-10-09.
- **Trạng thái:** đề xuất để human review; chưa approve, không phải Sprint Plan hoặc quyền RUN.
- **Yêu cầu:** Coder dùng cùng bộ tool kỹ thuật của System Engineer, không phụ thuộc provider.
- **Identity:** đường dẫn tài liệu này; revision/hash approval theo storage contract hiệu lực, không tự tạo approval.

### Chốt ownership cho đợt này — SM code trực tiếp

- **Theo yêu cầu human:** SM là người trực tiếp khảo sát source, sửa code, bổ sung/chạy verification và báo cáo evidence cho O1–O6 sau khi được phép thực thi.
- **Chưa dùng SL:** không handoff SL, không yêu cầu tạo Sprint Plan, ticket/manifest/forecast hoặc dispatch Coder làm điều kiện bắt đầu đợt này. Không tự tạo SP runtime.
- **Phân biệt hai vai trò:** SM là người implement thay đổi hệ thống; role Coder là đối tượng runtime cần được thống nhất tool. SM không phải chuyển nhiệm vụ code sang Coder/Supervisor.
- **Architecture:** chỉ định hướng contract/guardrails, sửa plan và xử lý escalation; không code hoặc tự verdict implementation. Human chốt scope, quyền thực thi và acceptance; review độc lập theo quy trình hiệu lực, không mặc định kích hoạt SV/Reviewer runtime.
- **Không bypass policy:** quyền sửa file, chạy check, commit/push và rollout của SM vẫn theo authorization hiệu lực. Nếu đường code trực tiếp bị policy bắt buộc SP/ticket chặn, SM báo blocker cho human; không tự gọi SL, tạo SP hoặc nới policy.
- Các mục ticket/manifest/lifecycle dưới đây là **contract của sản phẩm cần giữ khi SM implement**, không phải yêu cầu SM lập SP cho công việc này. Đây là handoff trực tiếp theo chỉ định human, không sửa quy trình SL chung trong rulebook Architecture.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** owner System Engineer và ticket Coder được lắp tool theo các đường khác nhau; executor còn gắn tool/file aliases và luồng thực thi với provider.
- **Kết quả:** một contract Forge kỹ thuật dùng chung cho hai role; provider chỉ vận chuyển tool calls/results, không quyết định quyền repository.
- **Giá trị:** đổi provider không đổi tên, schema, ý nghĩa tool, verification hoặc boundary ticket.
- **Nguyên tắc:** thống nhất công cụ không đồng nghĩa nâng Coder thành System Engineer hoặc cấp quyền toàn project.

## 2. Phạm vi

### In scope

- Catalog/schema/version, service handlers và authorization pipeline dùng chung cho engineering tools.
- Adapter của mọi provider được cấu hình để thực thi Coder; provider mới phải qua cùng admission/conformance.
- Giữ scope, revision, approval, changed-path ledger, verification và checkpoint của ticket.
- Đồng bộ prompt/rulebook, runtime capability và hiển thị readiness/tool permissions trên Coding.
- Migration tương thích aliases/checkpoints cũ; coverage và verification cấp outcome.

### Out of scope

- Chuyển role Coder sang System Engineer, mở quyền ghi toàn project hoặc bypass immutable manifest.
- Tự approve, dispatch, chạy test, commit/push, rollout trong lượt thiết kế này.
- Thay storage Sprint Plan/approval contract, cho Coder sửa workflows/docs bị policy cấm.
- Bắt mọi provider có native web search, hoặc coi model/provider bất kỳ chắc chắn hỗ trợ tool calling.
- Refactor kiến trúc ngoài boundary bộ tool và adapter thực thi.

## 3. Hướng tiếp cận và guardrails

### 3.1 Contract kỹ thuật dùng chung — đề xuất

```text
Coder / System Engineer
  -> Execution context do Node cấp, giữ nguyên role thật
  -> Shared engineering catalog + policy-resolved tool descriptors
  -> Provider adapter: schema/transport/session, không cấp quyền
  -> Shared dispatcher: validate -> authorize -> scoped service
  -> Receipt + ledger + checkpoint -> Coding / Supervisor / Reviewer
```

| Nhóm | Tên canonical đề xuất | Contract bắt buộc |
| --- | --- | --- |
| Discovery | search_tree, list_files, search_text | Safe filters, scope và bounded output |
| Đọc | read_file, read_lines | Cùng checksum/source semantics và giới hạn đọc |
| Ghi | write_diff, edit_diff | Exact checksum; role policy AND mutable manifest; ghi ledger sau thành công |
| Verification | run_check | test/lint/typecheck/build qua Node; scoped command đã validate; evidence gắn revision và source snapshot |
| Git đọc | git_status, git_diff | Cùng workspace ticket, không lộ diff ngoài quyền đọc |
| Git mutation | commit_changes, push_commit | Quyền riêng theo action; ledger và exact commit; không suy ra từ role/provider |

- Catalog bao gồm toàn bộ tên kỹ thuật của System Engineer đã khảo sát. Tool có thể bị khóa bởi policy; Coding phải thể hiện rõ available/locked/unsupported và lý do.
- Với cùng role, scope, grants và service availability, mọi adapter conformant phải expose cùng canonical descriptors. Backend tiếp tục enforce kể cả tool bị gọi trực tiếp hoặc UI ẩn nó.
- `search_code` giữ như extension dùng chung nếu cần compatibility; không xóa trước khi SM xác minh consumers.
- `report_done`, `respond_to_review` là lifecycle extensions của ticket, không nhập ownership approval/review vào engineering tools.
- Chỉ tái sử dụng handler khi semantics thật sự tương thích. Owner conversation ledger và ticket ledger khác nhau: shared service phải nhận đúng execution-scoped ledger, không lấy owner ledger thay ticket ledger.

### 3.2 Authorization — bắt buộc

- Node cấp context từ artifact hợp lệ: identity, role, execution/task, workspace, revision/hash, scope, grants, policy version và ledger reference. Tên trường chi tiết do SM xác minh theo schema hiện hành.
- Request tool/model không được tự đổi role, capabilities, manifest, project root hoặc quyền commit/push.
- Coder giữ quyền đọc theo policy hiệu lực; mutable files lấy từ ticket đã khóa. Không sao chép `project_wide_access` của System Engineer.
- Shared authorization kiểm tra capability, lifecycle, role, safe path/symlink/protected paths, manifest và action grant. Missing/unknown/stale context phải fail closed.
- `commit_changes` chỉ commit changed paths hợp lệ trong ticket ledger sau authorization và gates hiệu lực; không stage toàn workspace.
- `push_commit` chỉ khả dụng khi policy ticket cho phép và human cấp quyền riêng cho đúng execution/commit/remote. Nếu policy hiện hành cấm Coder push, giữ khóa; muốn mở cần quyết định human và revision policy riêng.
- Có tool không phải quyền sử dụng; yêu cầu thiết kế này không được coi là cho phép commit/push.
- `run_check` không phải arbitrary shell: allowlisted executable/check type, command validation, workspace isolation và giới hạn tài nguyên; không bypass manifest qua script có side effect. SM phải chứng minh enforcement hoặc ghi blocker.

### 3.3 Provider adapters — bắt buộc

- Dùng shared catalog/dispatcher; adapter chỉ chuyển JSON Schema, tool-call IDs, results/errors và session lifecycle theo transport của provider.
- MCP hoặc function tools đều được, nếu bảo toàn canonical contract. Không copy danh sách capability riêng cho từng executor.
- Native shell/file-change/Git tools bị tắt hoặc chặn; prompt không phải security boundary.
- Admission xác minh configured provider/model có round-trip tool calling và isolation. Không hỗ trợ thì báo unsupported/block trước dispatch, không greeting, giả PASS hoặc âm thầm chuyển provider.
- SDK web search là optional provider capability, tách khỏi Forge parity và không có quyền repository; không đưa secrets/source riêng tư vào external search.
- Resume/retry phải xác minh revision và receipts, reconcile pending mutation trước replay; không lặp commit/push. Không chuyển provider session token sang provider khác.

### 3.4 Compatibility / migration / rollback

- Version canonical catalog/schema và policy; execution đã chạy giữ contract version của nó hoặc bị block có giải thích khi không thể resume an toàn.
- Aliases `Read/Glob/Grep`, `rg_files/rg_search/sed_lines` chỉ chuyển về canonical operations khi schema tương đương, vẫn qua cùng authorization.
- `run_test/check_test` không tự coi đồng nghĩa với `run_check`: SM xác minh async receipts, test selection và completion gates trước khi định nghĩa adapter tương thích.
- Consumers phải đối chiếu: prompts, SDK options/MCP, tool events, ticket completion, ledger, checkpoint/resume, tests và Coding.
- Cutover theo adapter đã đạt conformance; rollback routing/catalog version không mở quyền cũ, không xóa evidence hay replay mutation. Rollout owner do SM/human chỉ định trước RUN.
- Dependency thật sự: chốt canonical contract và security boundary trước acceptance adapter; đạt parity/lifecycle evidence trước chuyển routing production.

## 4. Khu vực dự kiến ảnh hưởng và evidence

Đã đọc trực tiếp source windows bên dưới; chưa chạy test/runtime. Candidate areas không phải mutable-file manifest.

| Khu vực | Fact được xác minh / giới hạn | Evidence |
| --- | --- | --- |
| Role catalog | System Engineer có 12 tools; owner Coder hiện chỉ read tools | backend/src/tools/owner-role-tool-policy.js:6–7,21–30 |
| Owner registry | Ghép Git/check tools theo role; alias discovery tới command tools | backend/src/tools/owner-conversation-tools.js:24–75 |
| Engineer handlers | run_check; commit theo owner conversation ledger; push exact SHA | backend/src/tools/owner-engineer-tools.js:8–73 |
| Owner SDK stream | Chỉ owner architecture/system_engineer; project-wide context cho engineer | backend/src/application/owner-sdk-stream.js:30–94 |
| Ticket executors | Claude-specific aliases; loại respond_to_review; OpenAI/Ollama greeting trong window đã đọc | backend/src/modules/supervisor/nodeforge-task-executors.js:18–80 |
| File policy | Quyền System Engineer và Coder không tương đương; protected paths/symlinks | backend/src/infrastructure/filesystem/file-service-role-policy.js:15–72 |
| Coder rulebook | Không commit nếu chưa được yêu cầu rõ; giữ ticket ownership | workflows/agents/coder/README.md:5–24 |
| Audit gốc | Đầu mối lịch sử; không coi mọi finding đã tái xác minh | workflows/audit/tool-for-coder.md |

Whole-file SHA-256 tại discovery:

- owner-role-tool-policy.js: `cc5782c8daea1eb8d81478fa964538520eb06d7a3dbe8227f93e728502aa1a3a`.
- owner-conversation-tools.js: `2f0047902b30fc2b930a3a1fe22044968128ecb806ef1e3ca3b240437279ae14`.
- owner-engineer-tools.js: `56fa5afd0dc89c736badde445db555f7ac6d0e9659c9d8c763a06708388e4a8f`.
- owner-sdk-stream.js: `bebb1f2e8d04fac5670282d3f6d0927eac4967d2ba3a87cbd66b44812dcbbd87`.
- nodeforge-task-executors.js: `36ebcc8e5fb2d0d41747ff557990f8ce77a3cb4443e69ec023621dd95d5b385d`.
- file-service-role-policy.js: `adfe695d0fbe6f1febaca7d0b7b1e9e0e9197255625f6bcd73584e140c2274bc`.

Phần mở đầu ARCHITECTURE.md mô tả filesystem trực tiếp, không đủ để xác định contract hiện hành toàn tài liệu. Không dùng phần đó để nới quyền; SM cần xác minh contract hiệu lực trước dispatch.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Guardrail / dependency |
| --- | --- | --- | --- |
| O1 | Một catalog kỹ thuật | Coder/Engineer dùng cùng version/schema/semantics; không còn inventory trùng theo provider; denied tools có reason | Giữ role và policy riêng |
| O2 | Parity mọi configured Coder provider | Conformance matrix theo provider/model: discovery/read/write/check/Git read; mutations được authorize hoặc denied nhất quán; unsupported block trước dispatch | O1; không fallback greeting |
| O3 | Không mở rộng quyền Coder | Negative evidence: scope escape, protected/symlink path, role/capability spoof, stale revision, unauthorized commit/push, native tool bypass đều bị chặn | Enforcement tại Node, không chỉ prompt |
| O4 | Verification thực chất | Focused check của code đã đổi chạy qua Node; command/status/log/artifact/source snapshot và criterion mapping; failed/cancelled/stale không thành PASS | Không coi PASS là full coverage |
| O5 | Lifecycle an toàn | report_done và review response hoạt động với canonical tools; reload/resume không mất ledger và không lặp mutation; checkpoint legacy tương thích hoặc blocked rõ | Không đổi approval/RUN gates |
| O6 | Coding minh bạch | UI lấy runtime readiness, catalog version, effective tools, scope, locked reasons và evidence; đổi provider không đổi ticket authority | UI không tự cấp quyền |

SM trực tiếp implement O1–O6, tự chọn trình tự và file thực tế trong scope được phép; báo cáo mapping outcome → thay đổi → verification/evidence và các blocker. Không cần phân rã thành SP/ticket, lập forecast hoặc giao việc cho SL/Coder trong đợt này. Candidate files không phải quyền ghi; SM phải xác minh source và authorization trước mutation.

## 6. Rủi ro, giả định và câu hỏi mở

| Nội dung | Tác động | Evidence / giả định | Người chốt / xử lý |
| --- | --- | --- | --- |
| Copy owner registry/context vào Coder sẽ mở quyền hoặc dùng sai ledger | Blocker | Các đường source khác scope và ledger | Architecture giữ guardrail; SM thiết kế binding |
| Coder push policy chưa được xác minh đầy đủ | Blocker cho mở push, không block read/write parity | Có handler owner không chứng minh quyền ticket | Human quyết định; mặc định locked |
| Provider/model có tool calling nhưng thiếu isolation hoặc semantics | Blocker cho adapter đó | Chưa có runtime conformance | SM cung cấp evidence; SV/Reviewer kiểm tra độc lập |
| Check command có thể gọi script side effect ngoài scope | Major | Đã đọc validation, chưa khảo sát execution sandbox | SM xác minh service boundary trước acceptance |
| Native aliases/checkpoint/completion phụ thuộc tool cũ | Major | Chưa khảo sát đầy đủ consumers | SM discovery/version migration; không đoán compatibility |
| Public event/schema/API có thể cần metadata mới | Major | Chưa chốt schema consumers | SM đề xuất backward-compatible extension; đổi semantics escalate Architecture/human |

Không đổi database/authentication semantics theo plan. Authorization và tool/event protocol là boundary có ảnh hưởng; mọi schema/API breaking change phải có consumer/version/migration review riêng.

## 7. Acceptance criteria của plan và handoff

- [x] Mục tiêu, scope và outcomes cho bộ tool thống nhất đã nêu rõ.
- [x] Facts có evidence, giả định và câu hỏi mở tách riêng.
- [x] Tái sử dụng công cụ không đồng nghĩa kế thừa quyền System Engineer.
- [x] SM sở hữu implementation trực tiếp và evidence O1–O6; không handoff SL hoặc tạo SP trong đợt này.
- [ ] Human approve đúng identity/revision/SHA-256 và cấp quyền thực thi theo contract hiệu lực; sửa plan không tự cấp quyền code.
- [ ] SM xác minh contracts/consumers/policy còn mở, sửa code và chạy verification được phép; báo cáo changed files, kết quả, coverage và blocker cho O1–O6.
- [ ] Human nhận evidence và tổ chức review độc lập theo quy trình hiệu lực; Architecture không tự verdict, không tự dispatch SV/Reviewer.
- [ ] Commit/push và rollout chỉ sau authorization/gates riêng; tài liệu này không đóng audit findings cũ.

**Đề xuất chốt:** cùng catalog, schema và service implementation; quyền hiệu lực theo role/ticket, không theo provider. Commit/push mặc định không tự cấp. Chưa có test, runtime verdict hoặc rollout trong lượt này.

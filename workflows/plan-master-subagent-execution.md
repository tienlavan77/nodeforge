<!-- Architecture plan: Master-SubAgent execution model — thay thế SL/SV/Coder pipeline bằng 2-layer orchestration với dedicated review phase. -->
# Plan: Master–SubAgent Execution Model

**Trạng thái:** Draft chờ human review/approval; không phải quyền RUN.
**Ngày lập:** 2026-10-15.
**Decision owner:** Project owner (human).

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Workflow hiện tại có 4 layers (Architecture → Sprint Leader → Ticket Supervisor → Coder/Reviewer). Mỗi layer thêm overhead: SL phân rã plan thành tickets với contracts, admission rules, DAG; SV quản lý execution loop per ticket; context bị fragment qua mỗi layer. Với plans vừa và nhỏ, overhead này lớn hơn giá trị nó mang lại — đặc biệt khi SL chỉ repackage outcomes thành tickets mà không thêm architectural insight.

- **Kết quả:** Mô hình 2-layer: **Master Agent** nhận approved plan, phân rã thành tasks, dispatch **Sub-Agents** (parallel), nhận kết quả, dispatch **Reviewer Agents** (parallel), iterate cho đến khi tất cả outcomes đạt acceptance criteria. Master giữ full plan context xuyên suốt. Ticket pipeline (SL/SV/immutable execution context) vẫn tồn tại cho plans lớn cần formal tracking, nhưng không bắt buộc cho mọi execution.

- **Giá trị:** Giảm time-to-first-code (không qua SL planning phase), giữ context tốt hơn (Master hiểu full plan), tận dụng Reviewer agents đúng vai trò (independent quality gate), đơn giản hóa workflow cho phần lớn use cases.

## 2. Phạm vi

### In scope

- Định nghĩa **Master Agent** role: nhận approved architecture plan, phân rã outcomes thành executable tasks, dispatch sub-agents, coordinate review phase, integrate results, report cho owner.
- Định nghĩa **Sub-Agent** role: nhận task với extracted context, implement trong bounded scope, return results + evidence.
- Định nghĩa **Review Phase**: Master dispatch Reviewer agents sau khi nhận sub-agent results, independent quality assessment per outcome/task.
- Định nghĩa **iteration loop**: Review findings → Master quyết định fix strategy → re-dispatch sub-agents hoặc fix-and-re-review.
- Lightweight task tracking (không cần full immutable ticket pipeline).
- Decision rules: khi nào dùng Master–SubAgent vs traditional SL/SV pipeline.

### Out of scope

- Thay thế hoàn toàn SL/SV/ticket pipeline — giữ lại cho plans cần formal immutable tracking, multi-sprint coordination, hoặc owner yêu cầu.
- Thay đổi Architecture Manager role, plan format, hoặc approval contract.
- Thay đổi Reviewer agent rulebook (`workflows/agents/reviewer/README.md`) — Reviewer giữ nguyên independence và review checks.
- Thay đổi Coder agent rulebook (`workflows/agents/coder/README.md`) — Sub-Agent kế thừa Coder rules cộng thêm Master-specific coordination.
- Thay đổi `.forge/` runtime state, Forge tools, hoặc Node infrastructure.
- Bỏ separation of duties: implementation author vẫn không thể self-approve.

## 3. Hướng tiếp cận và guardrails

### Ràng buộc bắt buộc

1. **Master giữ full plan context** — không fragment thành isolated ticket contracts. Master hiểu mọi outcome, guardrail, dependency, và acceptance criterion của approved plan.

2. **Phân rã là task assignment, không phải ticket creation** — Master chia work thành tasks dựa trên outcomes, nhưng không cần tạo formal ticket contract với admission rules, file budget, style classification. Task có: objective, scope (files/modules), acceptance criteria (trích từ plan), dependencies.

3. **Sub-Agent nhận extracted context, không phải full plan** — Master extract context relevant to từng task: outcome objective, acceptance criteria, candidate files, guardrails liên quan, dependencies. Sub-Agent có thể reference full plan nếu cần nhưng không nhận toàn bộ.

4. **Reviewer dispatch tách biệt** — Reviewer không chạy inline trong sub-agent execution. Master gọi Reviewer sau khi sub-agent report done, với full evidence (changed files, verification results, acceptance criteria mapping). Reviewer giữ nguyên independence rules (`workflows/agents/reviewer/README.md`).

5. **Separation of duties bắt buộc** — Sub-Agent implement, Reviewer review, Master coordinate. Master không self-review implementation. Sub-Agent không self-approve.

6. **Owner visibility** — Master report progress per outcome cho owner, không per ticket. Owner chat với Master để adjust priorities, scope interpretation, hoặc escalate decisions.

7. **Immutable evidence vẫn cần cho critical changes** — Khi task liên quan đến public contract, security, data semantics, hoặc migration: Master phải use formal ticket pipeline (SL/SV) thay vì lightweight tracking. Decision rule ở §6.

### Hướng đề xuất

- **Master Agent = enhanced owner-conversation engineer** — kế thừa `system_engineer` role trong owner conversation (đã có full context, project-wide scope, Forge tools) nhưng thêm capability: dispatch sub-agents, coordinate review, integrate results. Không phải agent type mới — là mode của owner conversation engineer.

- **Sub-Agent = bounded Coder** — nhận task từ Master, implement trong scope được giao, return results. Sử dụng cùng Forge tools như Coder nhưng không qua SV loop. Nếu task quá lớn, Master split và dispatch multiple sub-agents.

- **Review phase = batch independent reviews** — sau khi N sub-agents complete, Master dispatch N Reviewer agents (parallel). Mỗi Reviewer assess một task's implementation against acceptance criteria. Reviewer không biết về các tasks khác (independence). Master collect verdicts.

- **Iteration = Master-driven** — nếu Reviewer `request_changes`, Master phân tích findings, quyết định: (a) dispatch lại sub-agent với findings, (b) fix trực tiếp nếu minor, (c) escalate owner nếu scope conflict hoặc guardrail question. Không có automatic repair round limit — Master quyết dựa trên context.

### Dependency thật sự

- Chốt decision rules (§6) trước khi implement: khi nào dùng Master–SubAgent, khi nào fallback về SL/SV.
- Chốt lightweight task tracking format trước khi dispatch sub-agents.
- Chốt review coordination protocol (Master gọi Reviewer thế nào, evidence format) trước khi chạy review phase.

### Quyết định chưa chốt

- Sub-Agent có nên là separate conversation/process hay lightweight invocation trong cùng Node process? Ảnh hưởng infrastructure và context isolation.
- Master có tự fix minor review findings không, hay luôn dispatch sub-agent? Ảnh hưởng iteration speed vs separation of duties.
- Lightweight task tracking persist ở đâu? `.forge/runtime/master-tasks/` hay in-memory với checkpoint? Ảnh hưởng resume capability.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `workflows/agents/architecture/README.md` | Architecture plan format và approval contract — giữ nguyên | Đã đọc: 162 dòng, outcomes + guardrails + acceptance criteria — chắc chắn |
| `workflows/agents/sprint-leader/README.md` | SL role — giữ cho formal pipeline, bypass cho Master–SubAgent | Đã đọc: 122 dòng, planning authority + ticket contract — chắc chắn |
| `workflows/agents/supervisor.md` | SV role — giữ cho formal pipeline, bypass cho Master–SubAgent | Đã đọc: 27 dòng, dispatch + evidence tracking — chắc chắn |
| `workflows/agents/coder/README.md` | Coder rules — Sub-Agent kế thừa | Đã đọc: 27 dòng, implementation + verification rules — chắc chắn |
| `workflows/agents/reviewer/README.md` | Reviewer rules — giữ nguyên independence | Đã đọc: 30 dòng, independent assessment + severity — chắc chắn |
| `workflows/plan-pause-resume-direct-engineer.md` | Pattern cho direct engineer execution checkpoint — Master kế thừa | Đã đọc: 108 dòng, execution lifecycle + checkpoint — chắc chắn |
| `workflows/plan-reviewer-coder-collaboration.md` | Reviewer–Coder collaboration pattern — adapt cho Master–SubAgent | Đã đọc: 159 dòng, state matrix + repair loop — chắc chắn |
| `workflows/multi-agents/architecture-contact.md` | Inter-agent communication principles — áp dụng cho Master↔Sub | Đã đọc: 48 dòng, durable state + event signaling — chắc chắn |

Candidate areas là định hướng, không phải mutable-file allowlist.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Master Agent nhận approved plan và phân rã thành executable tasks | Master đọc approved plan, extract outcomes, tạo task list với: objective, scope, acceptance criteria, dependencies, candidate files. Task list cover tất cả outcomes của plan. Master giải thích phân rã cho owner trước khi dispatch | Guardrail 1-2; plan format §5 architecture README |
| O2 | Master dispatch Sub-Agents parallel với extracted context | Mỗi sub-agent nhận: task objective, relevant acceptance criteria, candidate files, applicable guardrails, dependency info. Sub-agents chạy độc lập, không block nhau. Master track progress per task | Guardrail 3; sub-agent scope bounded |
| O3 | Sub-Agent implement và return results với evidence | Sub-Agent sử dụng Forge tools để implement, tạo verification evidence (test results, changed files, checksums). Report done với: changed files list, verification results, self-assessment against acceptance criteria | Guardrail 5; Coder rules kế thừa |
| O4 | Master dispatch Reviewer agents independent | Sau khi sub-agent(s) complete, Master dispatch Reviewer(s) với: implementation evidence, acceptance criteria, changed files. Reviewer assess độc lập (không biết về sub-agent khác). Master collect verdicts | Guardrail 4-5; Reviewer README rules |
| O5 | Iteration loop: review findings → fix → re-review | Master phân tích review findings, quyết định strategy per finding: dispatch sub-agent fix, self-fix minor, hoặc escalate owner. Fix implementation → re-review. Loop đến khi tất cả outcomes đạt acceptance hoặc escalate | Guardrail 5; Master không self-review |
| O6 | Decision rules rõ ràng cho Master–SubAgent vs formal pipeline | Document khi nào dùng Master–SubAgent (plans vừa/nhỏ, không cross-contract, owner preference) vs SL/SV pipeline (plans lớn, multi-sprint, formal immutable tracking required, public contract changes). Decision rules được apply consistently | Guardrail 7; §6 below |
| O7 | Owner visibility và control | Owner chat với Master để: xem progress per outcome, adjust priority, clarify scope interpretation, approve/reject review escalation. Master report: completed outcomes, pending tasks, review findings, blockers. Owner có thể pause/resume/abort execution | Guardrail 6; conversation checkpoint pattern |

**Gợi ý delivery (không bắt buộc):** O6 (decision rules) trước → O1-O2 (Master phân rã + dispatch) → O3 (Sub-Agent execution) → O4-O5 (Review + iteration) → O7 (Owner UX). SL tự quyết trình tự/phân rã.

## 6. Decision Rules: Master–SubAgent vs Formal Pipeline

### Dùng Master–SubAgent khi:

- Plan có ≤ 5 outcomes, không cross-project.
- Không thay đổi public contract, security/data semantics, hoặc migration.
- Owner prefer speed over formal tracking.
- Estimated implementation ≤ 1 sprint (không cần multi-sprint coordination).
- Tất cả outcomes có thể verify bằng automated tests (không cần human acceptance testing).

### Dùng Formal Pipeline (SL/SV) khi:

- Plan có > 5 outcomes hoặc cross-project dependencies.
- Thay đổi public API, schema, event, database, protocol, auth, hoặc permission.
- Cần immutable execution evidence cho audit/compliance.
- Owner yêu cầu formal ticket tracking.
- Cần multi-sprint coordination hoặc phased rollout.
- Previous Master–SubAgent attempt failed và cần structured recovery.

### Hybrid:

- Master–SubAgent cho bulk implementation, formal ticket cho critical path items (contract changes, migrations).
- Master coordinate cả hai tracks, report unified progress.

## 7. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Master là single point of failure | Major | Master giữ full context + coordination; nếu Master crash, toàn bộ execution dừng | Execution checkpoint pattern (plan-pause-resume-direct-engineer.md); resume từ last checkpoint |
| Sub-Agent context extraction không đủ | Major | Sub-Agent thiếu context → implement sai → review fail → rework | Master verify sub-agent understanding trước dispatch; sub-agent ask clarification |
| Review coordination overhead | Minor | Dispatch N reviewers parallel có thể overload provider | Master batch reviews hoặc sequential dispatch tùy provider capacity |
| Lightweight tracking mất data khi crash | Major | In-memory task state mất khi restart | Checkpoint task state to `.forge/runtime/` per existing pattern |
| Scope creep: Master tự expand scope | Major | Master có full plan context, có thể interpret rộng hơn owner intent | Guardrail: Master report scope interpretation cho owner trước dispatch |
| Formal pipeline bypass bị abuse | Major | Developer prefer Master–SubAgent để avoid formal tracking cho critical changes | Decision rules (§6) enforced; critical changes auto-route to formal pipeline |
| Sub-Agent vs Coder confusion | Minor | Sub-Agent kế thừa Coder rules nhưng hoạt động khác (no SV loop) | Document rõ Sub-Agent role; reuse Coder README với Master-specific additions |

## 8. Acceptance criteria của plan

- [ ] Mục tiêu, in/out scope và outcomes nhất quán với yêu cầu đơn giản hóa workflow.
- [ ] Facts từ agent rulebooks có evidence; assumptions ghi rõ.
- [ ] Guardrails (separation of duties, Master giữ context, Reviewer independence) tách khỏi gợi ý delivery.
- [ ] Decision rules (§6) rõ ràng, apply được.
- [ ] Mỗi outcome có tiêu chí quan sát được.
- [ ] Không áp đặt implementation details cho Master/Sub-Agent.
- [ ] Formal pipeline vẫn available cho plans cần nó.
- [ ] Approval đúng identity/revision/SHA-256; plan không tự RUN/dispatch.

## 9. So sánh với current architecture

| Aspect | Current (SL/SV) | Proposed (Master–SubAgent) |
|--------|-----------------|----------------------------|
| **Layers** | 4 (Arch → SL → SV → Coder) | 2 (Master → Sub-Agent) |
| **Context** | Fragmented per ticket | Master giữ full plan context |
| **Review** | SV dispatches Reviewer per ticket | Master dispatches Reviewer batch |
| **Tracking** | Immutable ticket pipeline | Lightweight task tracking |
| **Overhead** | High (ticket contracts, DAG, admission) | Low (task assignment) |
| **Parallelism** | Multiple SVs parallel | Multiple Sub-Agents parallel |
| **Resume** | Per-ticket checkpoint | Master checkpoint + task state |
| **Owner interaction** | Chat với SL hoặc qua UI | Chat trực tiếp với Master |
| **Use case** | Large plans, formal tracking | Most plans, speed-focused |

**Không replace, complement:** Formal pipeline giữ cho plans cần immutable evidence, multi-sprint, hoặc cross-contract changes. Master–SubAgent cho phần lớn use cases còn lại.

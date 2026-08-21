# Forge — Code Review Report

**Ngày:** 2026-08-20
**Scope:** Toàn bộ codebase src/, schemas/ so với ARCHITECTURE.md và STRUCTURE.md
**Tổng số findings:** 75+ issues phân loại

---

## Executive Summary

Codebase đã implement được ~9 sprints (Sprint 0–9) với lượng code khá lớn (~103 files trong src/). Kiến trúc tổng thể khớp với ARCHITECTURE.md, nhưng có **nhiều vấn đề nghiêm trọng về chất lượng, bảo mật, và data consistency** cần fix trước khi deploy production.

### Điểm mạnh
- ✅ Structure `src/modules/` đúng theo STRUCTURE.md
- ✅ Schema layer rất đầy đủ (~75 files JSON schemas)
- ✅ Agent protocol provider-neutral cơ bản đã có
- ✅ Workflow state machine được định nghĩa qua schema (không hard-coded if/else)
- ✅ Watcher + incremental index + dependency graph hoạt động tốt
- ✅ Recovery module có dead-letter queue, retry policy, event replay
- ✅ Governance layer (sprint planner, architecture decision tracker) là value-add超出 arch spec

### Vấn đề chính
- 🔴 **Bảo mật**: Secrets (.env, keys) không được redaction — gửi thẳng cho LLM
- 🔴 **Data loss**: Event store, History archive, DLQ toàn bộ in-memory — mất hết trên restart
- 🔴 **Race conditions**: Concurrent workflow transitions, idempotency cache, rename detection
- 🟡 **Architecture drift**: Context budget advisory thay vì enforcement, test runner không timeout
- 🟡 **Quality**: N+1 queries, memory leaks, unhandled exceptions, no transactions

---

## Critical Issues (Cần fix ngay)

| # | Category | File | Issue | Arch Ref |
|---|----------|------|-------|----------|
| C1 | **Security** | context-read-handler.js:24-55 | `.env`, secrets files đọc trả về agent không redaction | ch.46 |
| C2 | **Security** | context-engine.js:71-110 | Context builder chọn file từ index mà không filter secrets | ch.46-47 |
| C3 | **Data Loss** | event-store.js:12 | In-memory event store = mất hết events trên crash | ch.43 |
| C4 | **Data Loss** | history-store.js:37-52 | Archive records in-memory, mất trên restart | ch.34 |
| C5 | **Data Loss** | dead-letter-queue.js | Không có dequeue/drain mechanism → memory leak vô hạn | ch.43 |
| C6 | **Bug** | persistent-event-store.js:22-28 | DB insert thành công nhưng内存 update thất bại → inconsistency | ch.41 |
| C7 | **Bug** | subscription-registry.js:29 | Một handler throw → giết chết cả pipeline event delivery | ch.40 |
| C8 | **Schema** | envelope.schema.json:16,19,... | Bare `$ref` paths (`common.schema.json`) khác convention project | - |
| C9 | **Schema** | rule.schema.json:34-49 | allOf forces `condition_language` cho cả advisory rules | ch.19 |
| C10 | **Architecture** | context-engine.js:62-63 | Token budget chỉ advisory, không enforce | ch.49 |
| C11 | **Architecture** | command-idempotency.js:30-31 | Cache race condition: lệnh execute trùng nhau khi error | ch.42 |
| C12 | **Architecture** | state-machine-executor.js:21-44 | Không có optimistic locking → concurrent transitions overwrite | ch.51 |
| C13 | **Architecture** | runner.js + command-executor.js | Test runner không có timeout | ch.44 |
| C14 | **Architecture** | watch-project.js:66 | `database.close()` crash khi early failure vì thiếu optional chaining | - |

## High Issues (Quan trọng)

| # | Category | File | Issue |
|---|----------|------|-------|
| H1 | Race Condition | debounced-watcher.js:68-77 | Rename detection linear scan O(n), thiếu TTL cho pending adds/deletes |
| H2 | Error Handling | incremental-indexer.js:44-60 | Không có transaction wrapping → partial writes trên DB error |
| H3 | Performance | incremental-indexer.js:84-88 | N+1 symbol inserts (100 symbols = 100 round-trips) |
| H4 | Architecture | workflow-transition-gate.js:87-101 | Recursive transition() từ respondOwner() → infinite recursion risk |
| H5 | Security | http/server.js:20 | HTTP API không có authentication/authorization |
| H6 | Reliability | runtime-stream.js:23 | SSE write errors không check → backpressure dẫn đến OOM |
| H7 | Architecture | event-replay-engine.js:28-64 | Replay engine chỉ cover agent states, bỏ sót 50+ event types |
| H8 | Data Consistency | event-store.js:48-54 | project_id bị mất khi persist → multi-project breakdown |
| H9 | Memory Leak | debounced-watcher.js:42 | contentHashes Map không expiration → grows forever |
| H10 | Architecture | retry-policy.js:20 | Exhausted retries throw lên trên thay vì vào DLQ |
| H11 | Bug | workflow-transition-gate.js:157-162 | Read-modify-write không atomic → two transitions both pass read-check |
| H12 | Data Loss | event-publisher.js:27 | project_id duplicate trong metadata + top-level field |
| H13 | Architecture | verification/orchestrator.js:56-58 | Test + Check chạy parallel → test fail do build fail, khó debug |
| H14 | Memory | task-summary-store.js:19 | Summary cache evict mỗi lần build() |
| H15 | Schema | event.schema.json:65-75 | Duplicate event names: agents.started vs agent.started |

## Medium Issues (Nên fix)

| # | Category | File | Issue |
|---|----------|------|-------|
| M1 | Performance | context-engine.js:164-167 | getIndexVersion full-table scan mỗi lần build context |
| M2 | Bug | context-read-handler.js:62-64 | Path traversal check có thể bypass trên symlink/case-insensitive FS |
| M3 | Architecture | agent-process.js:158-163 | stdin write backpressure không handle → data drop |
| M4 | Quality | parser/javascript.js:27-32 | AST traversal Object.values() iterates tất cả properties including loc/range |
| M5 | Schema | common.schema.json:34-42 | "high" severity semantically ambiguous (priority vs severity) |
| M6 | Schema | test-result.schema.json + check-result.schema.json | Identical status enums duplicated thay vì share $defs |
| M7 | Bug | sprint-leader-loop.js:19,33,43 | Static UUID generation → defeat idempotency hoàn toàn |
| M8 | Architecture | change_area condition | Silent false khi context.path không có |
| M9 | Design | permission-evaluator.js:32-36 | Picomatch compiled per-evaluation thay vì pre-compile |
| M10 | Design | conversation-stream.js:27 | String vs numeric ID comparison strict equality === |

## Low Issues (Nice to have)

| # | Category | File | Issue |
|---|----------|------|-------|
| L1 | Style | contract.js:98 | Raw event type exposed to downstream listeners |
| L2 | Design | dependency-graph.js:18 | No index on target_file_id for markTargetBroken |
| L3 | Feature | file-repository.js:5-11 | language field always null |
| L4 | Feature | file-repository.js:6 | size_bytes never set |
| L5 | Style | http/server.js:24,39,... | Hardcoded route paths, không configuable |
| L6 | UX | cli/index.js:18 | Output format không consistent (plain text vs JSON) |
| L7 | Missing | event.schema.json:104-106 | sequence number not returned from in-memory store |
| L8 | Documentation | agent-schema.json vs session.schema.json | Status enum divergence undocumented |

---

## Priority Action Plan

### Phase 1: Security & Stability (Fix trong 1-2 ngày)
1. **Secrets redaction** trong context-read-handler.js và context-engine.js
2. **Transaction wrapping** trong incremental-indexer.js (B3, E1)
3. **Error isolation** trong subscription-registry.js (C4)
4. **database.close() fix** trong watch-project.js (Q6)

### Phase 2: Data Integrity (Fix trong 3-5 ngày)
5. **Persistent event store** default (C7)
6. **History archive persistence** (H3)
7. **DLQ drain mechanism** (R1)
8. **Optimistic concurrency** cho workflow transitions (C12)
9. **Project-scoped event subscription** cho history (H1)

### Phase 3: Architecture Compliance (Fix trong 1 tuần)
10. **Context budget enforcement** (C10)
11. **Test runner timeout** (C13)
12. **Idempotency fix** (C11)
13. **Event type deduplication** (M3 / event.schema.json)
14. **Workflow recursive guard** (H4)

### Phase 4: Quality & Performance (Ongoing)
15. **Batch inserts** cho symbols/imports (P1)
16. **Rename detection optimization** (B1)
17. **ContentHashes eviction** (P3)
18. **Schema cleanup** (C1, C2, M6)
19. **Performance profiling** cho context building

---

## Architecture Compliance Score

| Module | % Completeness | Notes |
|--------|---------------|-------|
| Schema (Sprint 0) | 90% | Rất đầy đủ, còn vài inconsistencies |
| Watcher/Index (Sprint 1) | 85% | Core logic good, bug risk trong rename detection |
| Project State (Sprint 2) | 80% | Registry tốt, session.store chưa persistent |
| Agent Protocol (Sprint 3) | 75% | Provider-neutral basic, idempotency gap |
| Verification (Sprint 4) | 70% | Missing timeout, parallel execution issue |
| Rule/Context Engine (Sprint 5) | 65% | Budget advisory, no secrets filtering (CRITICAL) |
| Workflow Engine (Sprint 6) | 80% | Good state machine, concurrency gap |
| Events/History (Sprint 7) | 60% | Data loss on restart (CRITICAL) |
| Transport (Sprint 8) | 75% | Missing auth, SSE backpressure |
| Recovery (Sprint 9) | 50% | DLQ never drains, recovery does nothing actionable |

**Overall: ~73% complete và architecturally aligned.** Có nhiều chỗ code đúng ý đồ kiến trúc, nhưng các critical gaps về data persistence, security filtering, và concurrency control ngăn không cho hệ thống vận hành production-ready.

# NodeForge — Tổng kết kiến trúc toàn dự án

> Ngày lập: 2026-09-11 · Rà soát trực tiếp trên repo (branch `task/FORGE-NOTIFY-001`, commit `c8f026b`).
> Nguồn nền: `ARCHITECTURE.md` (V1.3) + cấu trúc code hiện hành trong `backend/src`.

---

## 1. NodeForge là gì

**Hệ điều phối multi-agent (orchestrator) viết bằng Node.js**: Agent AI (Claude / Codex / OpenAI) tự do code trực tiếp trên filesystem; NodeForge là bộ não quan sát, điều phối, kiểm chứng và cấp context — **không phải proxy file**.

> Nguyên tắc xuyên suốt (ARCHITECTURE.md mục 60):
> *"Không bắt AI làm việc mà Node làm rẻ được; không bắt Node thay AI suy luận."*

---

## 2. Kiến trúc tổng thể

```text
┌───────────────────────────  UI (Next.js :3000)  ───────────────────────────┐
│  Dashboard · Sprint/Tickets · Agents · Chat owner · SSE realtime stream    │
│  ui/nextjs: NodeForgeShell/Panels, Dashboard, StreamingPanel, ThemeToggle  │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │ HTTP + SSE
┌──────────────────────────────▼───────────────────────────────────────────┐
│                    CONTROL API / NODE (backend :3100)                    │
│                                                                          │
│  transport/   http (server.js + forge-v1-router) · sse (conversation     │
│               stream) · cli                                              │
│  application/ owner-chat-service, ticket-command-parser,                 │
│               prose-ticket-service, sprint-orchestration,                │
│               sprint-plan-upload, dispatch-change, execution-layer,      │
│               project-dashboard, human-decision                          │
│                                                                          │
│  modules/                                                                    │
│   ├── supervisor/ ★  hub-and-spoke: supervisor-loop, round-controller,   │
│   │                   durable-queue + file-queue-store, sender/          │
│   │                   materializer/verification workers,                 │
│   │                   nodeforge-task-integration, protocol-storage,      │
│   │                   supervisor-state-store, processed-request-store,   │
│   │                   worker signal/result/status buses, recovery        │
│   ├── agent/        agent-gateway → provider-adapters (anthropic/codex/  │
│   │                   openai/devquote), claude-sdk-gateway,              │
│   │                   codex-sdk-gateway + codex-forge-tool-loop,         │
│   │                   openai-sdk-gateway, agent-role-resolver,           │
│   │                   profile-store + persistent-secret-backend          │
│   ├── governance/   runtime-tool-governance, roadmap-store,              │
│   │                   governance-rules-engine, sprint-leader,            │
│   │                   architecture-manager, ticket-provenance            │
│   ├── index/        incremental-indexer, code-search, file/function/     │
│   │                   dependency graph, code-index-summary-builder,      │
│   │                   relevant-tree, context-planner                     │
│   ├── verification/ verification-plan-builder, check-runner,             │
│   │                   orchestrator (Node chạy test chính thức)           │
│   ├── context/      context-engine + secret-paths (Token Firewall)       │
│   ├── events/       event-publisher, persistent-event-store,             │
│   │                   subscription-registry, unified-stream-order        │
│   ├── history/      history-store, task-summary, project-memory,         │
│   │                   memory-retriever                                   │
│   ├── projects/     project-registry, task-store, ticket-status-store    │
│   ├── protocol/     envelope-validator, payload-schema-registry,         │
│   │                   conversation-state-store                           │
│   ├── recovery/     dead-letter-queue, event-replay, idempotent-         │
│   │                   recovery, retry-policy, workflow-resume            │
│   ├── rules/        permission-evaluator, workflow-rule-evaluator        │
│   ├── watcher/      debounced-watcher, watch-project                     │
│                                                                          │
│  tools/       Forge tools có governance (authorizeTool +                 │
│               governance.dispatch): search_code, read_file,              │
│               write_diff, run_test, check_test, commit_changes,          │
│               report_done, read_code, read_transcript_blocks,            │
│               select_code_graph_candidates, retrieval-governance         │
└───────────────┬─────────────────────────────┬────────────────────────────┘
                │ agent-gateway (HTTPS)       │ watches / indexes
┌───────────────▼───────────────┐   ┌─────────▼──────────────────────────┐
│   EXTERNAL AGENTS             │   │   FILESYSTEM + GIT = source of     │
│   Claude (Claude Agent SDK,   │   │   truth                            │
│     MCP Forge tools)          │   │   .forge/runtime/ = Node-owned     │
│   Codex (Responses function-  │──►│   state (index.db, queues, logs)   │
│     calling loop)             │   │                                    │
│   OpenAI (SDK hello path)     │   │   Agent CHỈ gọi Forge tools;       │
└───────────────────────────────┘   │   built-in shell/file/patch/search │
                                    │   bị chặn cứng (tools: [])         │
                                    └────────────────────────────────────┘
```

---

## 3. Luồng chạy chính (ticket-driven)

```text
UI: bấm RUN trên ticket
  → dispatchTicket → Supervisor chọn Agent Profile (enabled + status ready,
    qua agent-role-resolver — không còn fixed agent hay auto-create)
  → enqueue handoff (durable queue) → sender-worker → agent-gateway
  → adapter theo provider (anthropic / codex / openai / devquote)
  → Agent gọi Forge tools — mỗi call đi qua:
       authorizeTool (agent-lifecycle-tools) + governance.dispatch
       (runtime-tool-governance: allowed_file_paths exact-match,
        allowed_prefixes startswith, checksum write_diff)
  → ghi file thật trên filesystem → commit_changes → report_done
  → Verification Worker (Node chạy test chính thức — Builder không được
    tự claim PASS, ARCHITECTURE.md mục 62)
  → ticket-status-store → SSE stream về UI + project log (`.forge/runtime/nf`)
```

Mốc đã hoàn thành 2026-09-10/11: **Codex chạy ticket thật qua Responses
function-calling loop** (`codex-forge-tool-loop.js`) — prompt build từ
title/objective/acceptance_criteria của ticket, target file trích từ path-token
trong ticket text (`ticketTargetPath`), governance scope theo file đó.
Lab 6-tool cũ vẫn giữ qua `payload.tool_test`. Bằng chứng end-to-end:
ticket `TICKET-DOC-VALIDATE-SCHEMAS` → commit `9315636` (comment summary đầu
`backend/scripts/validate-schemas.mjs`, source log `codex-sdk-ticket`).

---

## 4. Trụ cột thiết kế

| Nguyên tắc | Thể hiện trong code |
|---|---|
| Filesystem = source of truth; Code Index = cache; UI chỉ hiển thị | `.forge/runtime/` gitignored; watcher ignore `.forge/**`; UI nhận event qua SSE, không tự suy luận state |
| Hub-and-spoke | Supervisor là hub duy nhất; sender/materializer/verification workers chỉ trả kết quả về Supervisor, không worker nào gọi worker nào; repair do round-controller điều phối (repair-worker-production chỉ build request) |
| Token Firewall | Context engine lọc/chuẩn hóa/chọn lọc trước khi đưa cho Agent; test-failure schema cắt log 10k dòng → ~200 bytes/failure (ARCHITECTURE.md mục 62.5) |
| Protocol-driven | ~170 schema trong `schemas/` (16 nhóm: core, agent, governance, supervisor, worker, execution, stream, log…); envelope-validator + payload-schema-registry validate mọi command/event/ticket; Ajv 2020-12 |
| Governance reactive, không sandbox OS | Agent ghi file tự do (ARCHITECTURE.md mục 3/52); enforcement ở tầng tool-call (allowlist, path guard, checksum) + tầng tiến độ (WF-rules, verification gate) |
| Secrets | Profile chỉ giữ `credential_ref`; key thật nằm trong persistent-secret-backend; không vào payload queue, persistence, log, terminal, HTTP response |
| Idempotency + recovery | processed-request-store chống duplicate; durable queue recover khi restart; event-replay + workflow-resume; crash không hỏng project (filesystem là truth) |

---

## 5. Hiện trạng số liệu

- **~220 module source** (`backend/src`), **217 test files** (unit / integration / tools)
- **~170 schema** trong `schemas/`; snapshot sang `.forge/schemas` lúc runtime qua `forge-layout.js` (SNAPSHOT_DIRECTORIES = schemas, rules, workflows)
- UI: Next.js canonical (`ui/nextjs`); Vite legacy (`frontend/`) đã xóa tại `c8f026b`
- Control API `:3100`, project mặc định `PROJECT-NODEFORGE` (`NODE_CONTROL_PROJECT_ID`), persistence `.forge/runtime/nf` (`NODE_CONTROL_DATA_DIR`)
- Node >= 22.5, pnpm workspace; script chính: `pnpm dev` (Control API + Watcher + UI), `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm validate:schemas`

---

## 6. Việc đang treo (nợ kỹ thuật đã ghi nhận)

1. **`supervisor-loop.js:36`** — biến `initial` chưa định nghĩa trong `onEvent` (ReferenceError tiềm ẩn); đã defer khỏi PR hiện tại.
2. **Sync contract `read_code` / `commit_changes`** với schema tools (`schemas/agent/tools/*.schema.json`) — đọc/ghi chưa khớp 1:1.
3. **Dọn path MCP bridge chết + prop `codexSdkGateway`** (`production-runtime.js:54`) — 6-tool Codex RUN đã đi qua function-calling loop, đường CLI+MCP (`codex-forge-mcp-session.js`, `codex-forge-mcp-bridge.mjs`) không còn được caller nào dùng cho luồng này.
4. **2 lỗi `pnpm validate:schemas` tồn tại từ trước commit Codex** (không phải do agent gây ra):
   - `rules/forge-sprint-delivery.rules.json` đã bị xóa trong working tree nhưng `backend/scripts/validate-schemas.mjs:67` vẫn trỏ tới → ENOENT. Cần quyết: bỏ dòng fixture hay khôi phục ruleset (xem ARCHITECTURE.md mục 66.5 — ruleset giữ về nguyên tắc nhưng field artifact phải viết lại khi Rule Engine lên Sprint 5).
   - `schemas/examples/governance-agent-profile.json` chưa cập nhật theo schema mới (`role` bắt buộc, `agent_id` uuid, `status` enum ready/working/not_connected).

5. **Theo dõi thêm (từ ARCHITECTURE.md mục 66):** bất nhất số ít/số nhiều trong domain event `agent.stream` vs `agents.*`; ruleset WF-001…WF-008 cần map lại field artifact trước khi kích hoạt Rule Engine.

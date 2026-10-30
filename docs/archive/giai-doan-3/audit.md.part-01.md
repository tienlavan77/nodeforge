<!-- Preserves an ordered historical design section so repository restructuring retains the full technical discussion and can verify its original checksum after splitting. -->
# NodeForge — Comprehensive Project Audit

**Ngày rà soát:** 2026-09-09  
**Phạm vi:** toàn bộ repository, backend runtime, agent pipeline, API, schema, workflow, frontend, test và trạng thái triển khai local.

## 1. Tổng quan dự án

NodeForge là hệ thống điều phối multi-agent. NodeForge không trực tiếp suy luận hay viết code thay agent; NodeForge quan sát filesystem, duy trì code index, chuẩn hóa context/protocol, điều phối supervisor và worker, chạy verification, lưu event/history và stream trạng thái về UI.

Mô hình tổng quát:

```text
Human / UI
   │
   ▼
NodeForge Control API
   │
   ▼
Supervisor theo từng task
   │
   ├── Sender Queue → Sender Worker → Agent Gateway → AI Agent
   │
   ├── Materializer Queue → Materializer Worker
   │                              ├── Valid Patch
   │                              └── Invalid Patch
   │
   ├── Verification Worker
   │
   └── Repair Worker
```

Các nguyên tắc kiến trúc chính:

- Filesystem và Git là source of truth của source project.
- `.forge/` là runtime/config state do NodeForge quản lý.
- Agent được phép trực tiếp đọc/ghi source project.
- NodeForge quan sát filesystem, không cần proxy từng thao tác file của agent.
- Worker chỉ thực hiện một loại công việc; Supervisor mới điều phối vòng đời task.
- Schema là contract giữa các thành phần.
- Context được chọn lọc qua index, graph, summary và budget; không đưa toàn bộ project cho AI.
- Verification chính thức là kết quả do NodeForge lập kế hoạch, chạy, chuẩn hóa và persist.

## 2. Cấu trúc repository

Các khu vực chính:

```text
nodeforge/
├── backend/        # NodeForge backend và tests
├── frontend/       # Next.js frontend hiện tại
├── ui/             # frontend/client Next.js khác và build artifact
├── schemas/        # protocol và domain contracts
├── workflows/      # workflow state machines
├── docs/           # architecture, plans, sprints, reports
├── backup/         # tài liệu/schema cũ
├── config/         # cấu hình mặc định
├── agent-tool/     # tool runtime/handlers
├── Skills/         # hướng dẫn coding
└── .forge/         # runtime state local
```

`STRUCTURE.md` mô tả layout module theo hướng `src/bootstrap`, `src/application`, `src/domain`, `src/modules`, `src/infrastructure`, `src/transport` và `src/shared`. Repository thực tế hiện có thêm các khu vực legacy/parallel như `backend/src/agents`, `backend/src/core` và cả hai `frontend/`, `ui/`, vì vậy cấu trúc thực tế chưa hoàn toàn khớp tài liệu lý tưởng.

Tại thời điểm audit, working tree có khoảng **151 file modified** và **96 file untracked**. Đây là trạng thái thay đổi rộng, bao gồm cả runtime/generated/test/tài liệu và nhiều feature khác nhau. Không được reset, cleanup hoặc commit toàn bộ một cách mù quáng; trước hết phải phân loại từng nhóm thay đổi.

## 3. Cách khởi động và composition root

Các lệnh chính trong `package.json`:

```bash
pnpm dev
npm run dev:node
npm run dev:watcher
npm run dev:forge
npm test
npm run lint
npm run typecheck
npm run validate:schemas
```

`pnpm dev` gọi `backend/scripts/dev-workspace.mjs`, dự kiến khởi động:

```text
Control API  :3100
Filesystem Watcher
Code Index
Next.js UI   :3003
```

Composition root production là:

```text
backend/scripts/start-control-api.mjs
```

Luồng khởi động:

```text
load env
  → read runtime config
  → create storage
  → create profile/secrets/gateway
  → create platform services
  → create production supervisor runtime
  → recover previous tasks
  → start workers
  → start HTTP API
```

Các service được nối trong composition root gồm:

- SQLite/control database và index database.
- File service và protocol storage.
- Agent profile store.
- Node agent configuration projection.
- Secret backend.
- Agent gateway.
- Roadmap, sprint, ticket status và dashboard.
- Event store, subscription và unified stream.
- Context engine, code search và relevant tree selector.
- Verification orchestrator.
- Production supervisor runtime.
- HTTP server và Forge v1 router.

Ngoài production composition root còn có `backend/src/bootstrap/index.js`, phục vụ `createBootstrap()` cho watcher/indexer/agent process pipeline. Cần xác định rõ abstraction nào là lifecycle chính, abstraction nào chỉ dùng cho test hoặc legacy; hiện hai hướng lifecycle cùng tồn tại.

## 4. Filesystem watcher và code index

### Watcher

Các thành phần:

```text
backend/src/infrastructure/filesystem/watcher.js
backend/src/infrastructure/filesystem/file-service.js
backend/src/modules/watcher/
backend/scripts/start-project-watcher.mjs
```

Watcher xử lý các event:

```text
CREATE, MODIFY, DELETE, RENAME, MOVE
```

Watcher phải bỏ qua ít nhất:

```text
.forge/**
.git/**
node_modules/**
dist/**
coverage/**
```

Để tránh đọc file khi agent còn đang ghi, pipeline cần debounce và file-stability check trước khi re-index.

### Code index

Các module chính nằm trong `backend/src/modules/index/`:

- `code-search.js`
- `code-index-summary-builder.js`
- `context-planner.js`
- `dependency-graph.js`
- `file-graph.js`
- `function-graph.js`
- `consistency-checker.js`
- `file-repository.js`

Code index cung cấp file/symbol/import/export/dependency/call/reference/test/summary/graph. Index là cache có cấu trúc, không phải source of truth. Khi index không nhất quán phải có khả năng full rebuild.

Context pipeline hiện theo hướng:

```text
Code Index
  → symbol selection
  → dependency selection
  → line-range selection
  → deduplication
  → structural/history/test summary
  → Context Pack
  → Builder / Reviewer
```

## 5. Persistence và runtime state

Infrastructure persistence:

```text

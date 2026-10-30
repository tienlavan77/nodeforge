<!-- Preserves an ordered historical design section so repository restructuring retains the full technical discussion and can verify its original checksum after splitting. -->
## 8. Provider pipeline

Provider adapters hiện có:

```text
backend/src/modules/agent/provider-adapters/
├── anthropic-adapter.js
├── claude-adapter.js
├── codex-adapter.js
├── custom-adapter.js
├── devquote-adapter.js
├── openai-adapter.js
├── openai-request-builder.js
├── openai-response-normalizer.js
└── openai-transcript-resolver.js
```

Pipeline mục tiêu:

```text
Canonical request
  → provider-specific mapping
  → provider transport
  → provider response normalization
  → canonical result
```

Đã chuyển theo hướng provider-neutral:

- Canonical payload được shape trước mapping.
- Claude/Anthropic và Devquote không nhận OpenAI-shaped payload.
- OpenAI-specific mapping nằm trong OpenAI adapter/builder.

Claude mapping phải giữ:

```text
instruction_blocks → system content blocks
cacheable: true     → cache_control: { type: "ephemeral" }
user_blocks         → initial user message
transcript_blocks   → assistant/tool history
capabilities        → tools
expected_output.transport = function_tool
expected_output.type      = code_needed
                       → forced tool call
```

Cần tiếp tục kiểm tra:

- `claude` và `anthropic` là provider riêng hay alias.
- `devquote` có cần xuất hiện trong schema/service hay không.
- canonical schema có bao phủ đầy đủ mọi adapter.
- transcript fallback khi provider chain hết hiệu lực.
- usage/cache metadata và raw response khi normalization lỗi.
- test provider thực tế thay vì chỉ test request builder.

## 9. Supervisor và worker pipeline

Supervisor production:

```text
backend/src/modules/supervisor/production-runtime.js
backend/src/modules/supervisor/supervisor-runtime.js
backend/src/modules/supervisor/supervisor-manager.js
backend/src/modules/supervisor/round-controller.js
backend/src/modules/supervisor/nodeforge-task-integration.js
```

Mô hình là một supervisor cho mỗi task:

```text
Task A → Supervisor A
Task B → Supervisor B
Task C → Supervisor C
```

Supervisor giữ task state, context, request/round state, retry/recovery và quyết định bước kế tiếp. NodeForge giao task và nhận kết quả cuối.

### Queue và worker

Các queue/store:

```text
durable-queue.js
file-queue-store.js
processed-request-store.js
execution-event-bus.js
```

Luồng chuẩn:

```text
Supervisor
  → sender queue
  → sender worker
  → Agent Gateway
  → Agent response
  → Supervisor
  → materializer queue
  → materializer worker
  → VP / iVP
```

Sau materialization:

```text
VP  → verification queue → verification worker → result event → Supervisor
iVP → repair queue        → repair worker        → result event → Supervisor
```

Worker không được tự điều phối worker khác bằng function call; giao tiếp đúng là command qua queue và event qua event bus.

### Recovery

Production runtime gọi `recover()` trước khi start workers. Sau restart cần:

- đọc state mới nhất,
- tìm round/task chưa terminal,
- kiểm tra persistence/provider status/checksum,
- polling nếu provider còn pending,
- dựng transcript fallback nếu chain mất,
- không tạo request mới khi round cũ chưa kết luận.

## 10. Materializer, patch và verification

Execution handlers:

```text
backend/src/application/execution-handlers/
├── apply-patch.js
├── backup.js
├── full-file-replace.js
├── search-replace.js
├── structured-patch.js
├── unified-diff.js
└── verify-checksum.js
```

Các lớp bảo vệ hiện có:

- validate patch wrapper/hunk/context,
- kiểm tra path đúng file yêu cầu,
- kiểm tra line position,
- checksum/concurrent modification detection,
- atomic apply gate,
- backup và repair khi apply thất bại.

Verification modules:

```text
backend/src/modules/verification/
├── check-runner.js
├── command-executor.js
├── orchestrator.js
├── runner.js
└── verification-plan-builder.js
```

Verification hỗ trợ các nhóm:

```text
test
build
lint
typecheck
```

Chỉ kết quả NodeForge chạy, normalize và persist mới được coi là evidence verification chính thức.

## 11. Event, history, governance và memory

Event modules:

```text
backend/src/modules/events/
```

Bao gồm event publisher/store, persistent store, subscriptions và unified stream ordering.

History/memory:

```text
backend/src/modules/history/
```

Bao gồm history store, memory retriever, project memory và task summary.

Governance:

```text
backend/src/modules/governance/

<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
# ARCHITECTURE.md — trích riêng cho Sprint 3 (Agent Protocol)

> File này là bản trích lọc từ `ARCHITECTURE.md` gốc, chỉ gồm các mục liên quan trực tiếp
> tới phạm vi Sprint 3 (`SPRINT_PLAN.md`): Agent tự do đọc/ghi filesystem, phân quyền,
> Agent Protocol (vocabulary command/event), Request/Event identity, Idempotency,
> Timeout/Cancel/Retry, Concurrent modification, nguyên tắc "không proxy filesystem".
> Đây KHÔNG phải bản thay thế `ARCHITECTURE.md` đầy đủ. Số thứ tự mục giữ nguyên như bản gốc.
>
> **Lưu ý ranh giới sprint quan trọng:** mục 43 (Crash recovery) trích ở đây chỉ để tham
> khảo thiết kế — logic phục hồi crash **đầy đủ** thuộc Sprint 9 (Hardening: Failure &
> Recovery), Sprint 3 chỉ cần đảm bảo Request/Event identity (mục 41) đủ nền tảng để Sprint 9
> dùng lại, không tự implement crash recovery ở đây. Tương tự, mục 29 (Agent Stream về UI)
> nhắc tới WebSocket/SSE — đó là Sprint 8 (Transport); Sprint 3 chỉ cần đưa stream qua
> `internalBus` nội bộ (như đã làm ở Sprint 1, NF-023), không tự dựng WebSocket server.

---

# 3. Agent trực tiếp đọc/ghi project

Không cần biến mọi thao tác filesystem thành API call qua Node.

Agent có thể:

```text
read file
write file
create file
delete file
rename file
run command
```

Ví dụ:

```text
Builder
  ↓
Filesystem
  ↓
src/auth.js
```

Việc `writeFile()` không tạo token AI riêng.

Token chủ yếu phát sinh khi:

```text
đọc code vào context → input tokens
suy luận → model computation
tạo code → output tokens
```

Do đó không cần:

```text
Builder
  ↓
Node API: WRITE_FILE
  ↓
Node
  ↓
Filesystem
```

trừ khi cần sandbox/security đặc biệt.

---

# 4. Agent có được ghi vào project mà Node đang theo dõi không?

**Có.**

Node theo dõi project không có nghĩa Node khóa project.

Ví dụ:

```text
              PROJECT
                 │
        ┌────────┴────────┐
        ▼                 ▼
      AGENT              NODE
        │                 │
   đọc/ghi code        theo dõi
        │                 │
        ▼                 ▼
     FILESYSTEM ──────► EVENT
                         │
                         ▼
                     CODE INDEX
```

Agent ghi file:

```text
Builder
  ↓
write src/auth.js
  ↓
Filesystem
  ↓
Node Watcher
  ↓
MODIFY src/auth.js
  ↓
Re-index auth.js
```

Node không cần cấp phép từng lần Agent ghi file.

Điều kiện:

- Node chạy với user có quyền đọc/ghi cần thiết.
- Agent chạy với quyền filesystem phù hợp.
- OS/sandbox không chặn truy cập.

Node và Agent là các process độc lập cùng truy cập filesystem.

---

# 5. Phân quyền
-e
---

# 5. Phân quyền

Nên có ranh giới rõ:

## Agent

```text
PROJECT SOURCE
  src/          READ/WRITE
  tests/        READ/WRITE
  config        READ/WRITE theo policy

.forge/
  READ hạn chế
  WRITE không được tự ý
```

## Node

```text
PROJECT SOURCE
  READ
  WRITE chỉ khi workflow yêu cầu

.forge/
  READ/WRITE
```

## Human

Có quyền theo filesystem/OS và project policy.

Node không phải file proxy/gatekeeper. Node là:

> Observer + Orchestrator + Verifier

---

# 6. `.forge/` thuộc về Node
-e
---

# 29. Agent Stream về UI

Node theo dõi stdout/stderr của Agent process:

```text
Agent
 │
 ├── stdout
 └── stderr
       ↓
     Node.js
       ↓
   WebSocket/SSE
       ↓
      UI
```

UI có thể có 4 khung:

```text
┌──────────────────┬──────────────────┐
│ Builder           │ Reviewer         │
│ realtime stream   │ realtime stream  │
├──────────────────┼──────────────────┤

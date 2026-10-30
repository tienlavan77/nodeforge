<!-- Preserves an ordered historical design section so repository cleanup retains the complete original technical discussion and supports checksum reconstruction. -->

### 7.4 Khả năng nhớ — 5 nguồn hiện có, mạnh yếu lẫn lộn

1. **Code Index** (`index.db` + context-engine) — nhớ về codebase: symbols, deps,
   graph. Context pack có budget (12k/40k/30k tokens theo role) + stale-guard sha256
   + index version. **Lớp nhớ mạnh nhất, đang sống tốt.**
2. **Project memory** (`project-memory-store.js`) — lọc facts dài hạn từ task
   summaries bằng regex (`decision|architecture|migrate|standard|must...`).
3. **Memory retriever** (`memory-retriever.js`) — **điểm yếu nhất**: AND-substring,
   mọi token của query phải xuất hiện trong fact → câu hỏi tự nhiên gần như luôn
   trả rỗng. Không rank, không recency.
4. **Transcript blocks + protocol storage** — nhớ ngắn hạn trong task, đã có
   summarize out-of-window.
5. **Knowledge/decisions stores** — có trong wiring nhưng **không được inject** vào
   prompt của đường session.

Hai khoảng trống nghiêm trọng:

- **Không ai GHI memory từ đường mới**: `task.completed` → không hook nào lưu
  summary/facts vào task-summary-store (đường `agent-runtime` /
  `external-agent-orchestrator` là đường cũ). Memory cạn dần nguồn.
- Giữa các attempt/task, agent chỉ có context pack Node build — chưa có project
  memory, decisions, lịch sử task đụng cùng module.

### 7.5 Thiết kế nhớ 4 lớp

```text
L0 trong-session:  transcript append-only (có sẵn)
L1 task pack:      index.db + structural summary + ticket + plan
                   → checksum vào context_revision, cache trong attempt
L2 project memory: conventions + past decisions + facts từ task đã xong
                   → block ổn định nhất → breakpoint đầu prompt (Tầng 1 cache)
L3 codebase truth: agent tự đọc qua search_code/read_code + code index
                   → không inject được (lớn, hay đổi) — giữ ở tool call,
                     đúng Token Firewall
```

3 việc theo thứ tự giá/công sức cho L2:

1. **Terminal hook ghi memory** (trùng với bridge terminal mục 6.1): task xong →
   summary session → facts (giữ regex filter) → memory. Memory mới có nguồn sống.
2. **Retriever nâng từ AND-substring → scoring**: điểm = số term khớp + recency
   (last_seen) + domain tag; top ~20 facts, cap prompt.
3. **Decay**: fact lâu không hit → archival, tránh memory thành bãi rác sau
   100 tickets.

---

## 8. Tool contract v2 — giải vấn đề full-content của `write_diff`

### 8.1 Vấn đề

Hiện tại cả 2 chiều đều full-content:

- **`write_diff`** (`agent-lifecycle-tools.js`): input `{path, content,
  before_checksum}` — agent phải gửi **toàn bộ nội dung file mới** (cap 200KB).
  Đổi 5 dòng trong file 300KB = gửi ~75k tokens.
- **`read_file`**: trả về **toàn bộ file** (cùng cap). Không có offset/limit.
- Đường patch (`structured_patch` + anchor_ok + atomic-apply-gate) tồn tại nhưng
  chỉ ở materializer của model cũ — đường session không expose cho agent.

Cái chết tiền thật sự không phải 1 lần gửi: **tool call nằm lại transcript** —
round 1 gửi 75k → round 2→12 mỗi round đều kéo theo 75k (cache giảm giá nhưng
context window vẫn bị đốt; 75k trên budget 40k là vỡ luôn).

| File 300KB, đổi 20 dòng | Token gửi lên | Token trong transcript các round sau |
|---|---|---|
| `write_diff` full content | ~75k | 75k × mỗi round |
| **`edit_file` anchor** | ~0.1k | ~0.1k |

≈ **750 lần rẻ hơn** chiều ghi, chưa tính chiều đọc.

### 8.2 3 mức, dùng theo kích thước thay đổi

**1. Thêm tool `edit_file` (anchor replace) — mức chính:**

```text
input: { path, before_checksum, anchor, replacement, occurrence: "first"|"all" }
- anchor: chuỗi exact phải unique trong file → không unique = ANCHOR_NOT_UNIQUE
- before_checksum: giữ nguyên guard như write_diff (chống stale write)
- server: read → verify checksum → tìm anchor → replace → atomicWrite
- trả về: sha256 mới + số thay đổi
```

Khái niệm anchor đã có sẵn trong materializer (gate `anchor_ok`) — chỉ là chưa
từng expose thành tool. Governance không đổi gì: `safePath` + `assertAllowed`
y như write_diff.

**2. `write_diff` giữ lại cho đúng việc của nó:** file mới (chưa tồn tại), file nhỏ
(<~20KB), hoặc rewrite gần toàn bộ. Không xóa.

**3. Chiều đọc: `read_file` thêm `offset/limit` (line range)** — context-engine đã
có khái niệm `line_ranges` + signature mode; chỉ là tool chưa nhận tham số.
Agent đọc vùng quanh anchor (line number từ `search_code`), không cần nuốt
300KB để tìm chỗ sửa.

### 8.3 Quy tắc chọn (đưa vào prompt Session Runner)

```text
file mới hoặc <20KB          → write_diff (full)
file lớn, sửa cục bộ          → read_file {offset,limit} quanh vị trí → edit_file {anchor}
sửa rải rác nhiều chỗ         → nhiều edit_file (mỗi cái 1 anchor)
```

Đây là pattern Claude Code / Aider / OpenAI `apply_patch` đều hội tụ về —
anchor-based edit là chuẩn de-facto của agentic coding: rẻ token và giảm lỗi drift.

---

## 9. Tổng hợp — trước / sau

| Khía cạnh | Hiện tại | Đề xuất |
|---|---|---|
| Trạng thái supervisor | 12 | 8 |
| Round | Phase (R1 task, R2 plan, R3 code) | Attempt (session; session 2+ = repair) |
| Workers | 3 + repair worker chết | 3 (Session Runner, Change-set Collector, Verifier) |
| Queues | 4 (`agent.request`, `materializer.request`, `verification.request`, `repair.request`) | 3 (`agent.request`, `collector.request`, `verification.request`) |
| Materializer | Apply patch 4 gate | Collector git diff + checksum |
| Round controller | ~350 dòng, R1→R3 + repair | Attempt-context builder ~50 dòng |
| Protocol storage | Hợp đồng điều phối | Bằng chứng audit (format ref giữ nguyên) |
| Plan gate | Bắt buộc R2 | Optional qua human-decision-service |
| Prompt cache | Không set trên đường session | 3 tầng payload + breakpoint + đo hit-rate |
| Server-side state | Đang ngủ trong conversation-state-store | Probe `previous_response_id` cho Codex (opt-in theo profile) |
| Project memory | Không có nguồn mới; retriever AND-substring | Terminal hook ghi memory + retriever scoring + decay |
| Tools ghi file | `write_diff` full content duy nhất | + `edit_file` anchor, `read_file` offset/limit |

---

## 10. Thứ tự thực hiện đề xuất (khi được phép code)

1. **Bridge terminal + terminal hook ghi memory** (mục 6.1 + 7.5.1) — giá rẻ,
   khớp nhau, sửa được 2 gap cùng lúc.
2. **State machine 12→8 + Session Runner + Collector + Verifier** (mục 2, 3) —
   phần lớn nhất, làm sau khi bridge xong để không phải migrate 2 lần.
3. **3 tầng payload + đo cache hit-rate** (mục 7.3) — đi kèm bước 2 vì đổi cấu trúc
   payload của Session Runner.
4. **Tool contract v2: `edit_file` + `read_file` offset/limit** (mục 8) — độc lập,
   có thể song song với bước 2.
5. **Probe `previous_response_id` qua gateway** (mục 7.1) — thí nghiệm, không chặn
   các bước khác.
6. **dispatchSprint DAG + consolidate sprint paths** (mục 6.2, 6.3) — sau khi
   pipeline mới ổn.

Mỗi bước giữ nguyên nguyên tắc: unit tests dùng mock, checksum guards không giảm
chất lượng, secrets không vào payload/log, unit test với mock gateway — smoke test
mới gọi gateway thật.

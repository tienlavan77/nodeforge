<!-- Preserves an ordered historical design section so repository cleanup retains the complete original technical discussion and supports checksum reconstruction. -->
# Đề xuất chỉnh sửa pipeline NodeForge

> Ngày lập: 2026-09-11 · Tổng hợp từ trao đổi với Owner sau khi đọc `pipeline-nodeforge.md`,
> `supervisor-legacy.md`, `audit-arch.md` và rà trực tiếp code (branch `task/FORGE-NOTIFY-001`,
> commit `c8f026b`).
> Trạng thái: **ĐỀ XUẤT — chưa chốt, chưa code** (đang giữ design gate).

---

## 0. Bối cảnh — vì sao phải sửa

Model hiện tại (supervisor-loop + round-controller R1→R3) sinh ra cho **"thin agent"**:
agent nghèo context, phải được Node dắt từng bước — R1 xin context (`code_needed`) →
R2 trả plan → R3 trả structured patch → Node materialize patch → R4+ repair.

SDK agent giờ là **agentic**: một session tự làm hết — tự đọc file, tự code qua Forge
tools, tự chạy test, tự sửa checksum lỗi, tự commit. Trên thực tế:

- Đường production (`dispatchTicket` → `submitTicket`) đã chọn theo provider:
  Codex → `codex-forge-tool-loop`, Claude → MCP session, Sender-worker có
  `runAgentTurns`. Round controller R1→R3 gần như không chạy thật — chỉ sống trong test.
- `MATERIALIZING` vô nghĩa với SDK path: agent đã ghi file trực tiếp.
- `REPAIRING` ngoài vòng lặp là thừa: agent tự repair trong session.
- **2 mô hình orchestration song song tồn tại** — Model A (supervisor-loop + round
  controller + materializer) và Model B (submitTicket → provider session loop),
  không ai gọi ai, rẽ nhánh ngay từ đầu.

→ Thống nhất về **Model B (session pipeline)**.

---

## 1. Round = Attempt (session), không còn là Phase

- `round_{n}` = lần gọi session thứ n. Session 1 = làm trọn bài.
  Session 2+ = repair (nhận failure context: test output, git diff hiện tại,
  correction text).
- Giữ nguyên ref phẳng `task/{id}/round_{n}/request|response` + transcript_blocks →
  audit trail không mất gì.

---

## 2. State machine 12 → 8 trạng thái

```text
CREATED → PREPARING → RUNNING (agent session, N tool turns)
       → VERIFYING (Node chạy authoritative check)
       → COMPLETED
       ↘ REPAIRING (session lại với failure context) → VERIFYING...
       → FAILED | NEEDS_HUMAN_REVIEW
```

| Cũ | Mới |
|---|---|
| `REQUESTING` + `WAITING_AGENT` | gộp thành `RUNNING` (session đang chạy = đang chờ agent) |
| `MATERIALIZING` | **bỏ** — agent tự ghi; verification đọc git change set thay vì apply patch |
| `WAITING_REPAIR` | gộp vào `REPAIRING` |
| `READY` | giữ (preparation xong) |

---

## 3. Workers: 3 worker, 3 queue

Vai đổi, số lượng giữ nguyên — nguyên tắc hub-and-spoke không đổi
(Supervisor là hub duy nhất, workers là spokes):

| Hiện tại | Mới | Thay đổi |
|---|---|---|
| **Sender Worker** (`runAgentTurns`, phân biệt RESPONSE_FUNCTION_TOOLS vs Forge tools) | **Session Runner** | Bỏ hẳn bộ response tools (`code_needed`, `planning`, `submit_code_response`, `patch_repair_response`…). Chạy 1 session agentic qua agentGateway (adapter codex/claude/openai), emit `session.result` |
| **Materializer Worker** (4 gate: structure/checksum/anchor/dry-apply) | **Change-set Collector** | Không apply patch nữa — chỉ `git status/diff` + checksum sau session, publish change set. Nhỏ hơn ~80% |
| **Verification Worker** | **Verifier** | Giữ nguyên vai — Node vẫn là nguồn sự thật PASS/FAIL (ARCHITECTURE.md mục 62) |
| ~~Repair Worker~~ (production) | **Xóa** | Đã chết từ trước (`repair.request` không còn ai enqueue) |

Xóa kèm theo: `repair-worker.js`, `repair-worker-production.js`, queue
`repair.request`, set `RESPONSE_FUNCTION_TOOLS`, và phần lớn round-controller
(R1→R3, `validatePlan`, `assertFullContext`) thu về một **attempt-context builder**
(~50 dòng): lần 1 gửi ticket + context pack, lần 2+ gửi failure context
(test output + git diff + correction text).

**Vì sao giữ Collector tách riêng (không gộp vào Session Runner):** queue là điểm
recovery. Session agent tốn tiền — nếu Node crash sau khi session xong mà chưa kịp
verify, job collector còn nằm trên durable queue; gộp thì crash giữa chừng = mất cả
cụm hoặc phải re-run session có phí.

Queue: 4 → **3** (`agent.request`, `collector.request`, `verification.request`).

---

## 4. Protocol storage — giữ, đổi vai từ "hợp đồng" sang "bằng chứng"

- **Cũ:** mỗi round là 1 khâu hợp đồng — Node đọc protocol để rebuild context cho
  round kế (R2 cần output R1, R3 cần full source).
- **Mới:** mỗi attempt lưu bằng chứng — prompt/context pack gửi vào session, response
  cuối, chuỗi tool exchange, kèm checksum `.meta.json` như cũ. Ref
  `task/{id}/round_{n}/...` giữ nguyên format (round = attempt), tránh churn code.

Lý do giữ:
1. **Sự cố & tranh chấp** — agent đã *thấy* context gì, làm sai chỗ nào: chỉ protocol
   storage trả lời được full fidelity (project log chỉ có bản tóm tắt).
2. **Repair context** — attempt-context builder đọc evidence attempt trước để đóng gói
   correction (kế thừa tinh thần transcript blocks hiện tại).
3. **Trụ cột protocol-driven** — Node vẫn là người giám sát/kiểm toán.

Thu hẹp được: giữ mức bắt buộc là request pack + final response; tool exchange là
best-effort (session ngắn hơn trước nên không tốn thêm).

---

## 5. Plan gate trở thành optional

Muốn human duyệt plan giữa chừng: agent emit plan + dùng `human-decision-service`
(có sẵn) → `NEEDS_HUMAN_REVIEW` → duyệt xong resume. Không ép mọi ticket qua gate
như R2 cũ (`persistPlan` hiện cũng chỉ là no-op).

---

## 6. Nhặt khoảng hở đã phát hiện (pipeline-nodeforge.md)

1. **Bridge terminal → ticket status**: `task.completed` / `task.failed` /
   `NEEDS_HUMAN_REVIEW` → subscribe → `ticketStatusStore.updateStatus` tương ứng +
   `roadmaps.updateTicketStatus` để UI dashboard thấy.
2. **`dispatchSprint` theo DAG dependencies**: sort theo `dependencies`, chạy từng
   ticket chờ terminal rồi mới dispatch ticket kế; gate bằng `dependenciesReady()`
   thay vì `Promise.all`.
3. **Consolidate 2 đường sprint orchestration**: đặt tên rõ
   (`sprint-plan-generation` vs `sprint-execution`) hoặc gộp.

---

## 7. Cache & khả năng nhớ của agent

### 7.1 Nguyên lý — cache server KHÔNG giảm băng thông

HTTP LLM API vốn stateless: client **luôn** gửi lại toàn bộ context mỗi call.
Prefix cache không phải "không cần gửi lại" mà là "**không phải tính lại**":

| | Băng thông upload | Chi phí token input | TTFT |
|---|---|---|---|
| Không cache | gửi full mỗi round | trả full giá mỗi round | chậm |
| **Prefix cache** (Anthropic `cache_control`, OpenAI auto ≥1024 token) | **vẫn gửi full** | prefix cached ~10% giá (Anthropic), OpenAI giảm 50–90% | nhanh |
| **Server-side state** (OpenAI Responses `store:true` + `previous_response_id`) | **chỉ gửi delta** | như trên | nhanh nhất |

Muốn gửi-lít-đi thật sự chỉ có 1 đường: OpenAI Responses `store:true` +
`previous_response_id`. Repo đã để sẵn chỗ cắm — `conversation-state-store.js`
lưu `last_provider_response_id`, `parent_request_id`, `prompt_cache_key`,
`context_revision`, `context_checksums` từ đầu — **đang ngủ, chưa adapter nào
gửi lên**.

⚠️ Gateway `sv.devquote.shop` là proxy — từng strip `tools` trước đây, có thể strip
`store`/`previous_response_id` → phải probe trước, giữ fallback full-resend.
`store:true` nghĩa là nội dung nằm lại server provider (~30 ngày retention) —
context pack đã lọc secret path rồi nhưng đây là copy thứ 2 ngoài `.forge` →
**opt-in theo profile**, không bật mặc định.

Anthropic Messages không có tương đương — đường Claude bắt buộc re-send,
prefix cache cứu.

### 7.2 Hiện trạng cache trong repo

Đã có 3 lớp sẵn:

| Lớp | Ở đâu | Trạng thái |
|---|---|---|
| Anthropic blocks | `request-builder.js` — block `cacheable` → `cache_control: ephemeral`; usage đã map `cache_read/creation_input_tokens` | Chỉ đường round-controller/stage1 dùng `instruction_blocks`; **đường session mới không truyền → cache = 0 trên Claude raw** |
| OpenAI/Codex | `openai-request-builder.js` — `cache_config` → `prompt_cache_key` + `{mode, ttl}`; developer blocks → `prompt_cache_breakpoint` | stage1 đặt key `forge:{project}:{sprint}:{ticket}` ttl 30m; đường session mới không set |
| Chaining | `conversation-state-store.js` — `prompt_cache_key`, `context_revision`, `context_checksums`, `last_provider_response_id` | Đang ngủ |

Đường session mới (`codex-forge-tool-loop`, Claude SDK): payload chỉ `{text, task_id}`
+ messages append — không `stable_context`, không `cache_config`. May mắn transcript
append-only nên prefix ổn định tự nhiên → OpenAI auto-cache vẫn ăn được, nhưng
**không kiểm soát breakpoint và không đo hit-rate** (usage normalize rồi nhưng
không tổng hợp vào đâu).

### 7.3 Thiết kế 3 tầng payload cho Session Runner

```text
Tầng 1  system + conventions + project memory   ← byte-identical QUA CÁC TICKET
        → breakpoint cuối tầng này: ticket mới vẫn hit cache tầng 1
Tầng 2  ticket + context pack (checksum index)  ← byte-identical TRONG attempt
        → breakpoint cuối: repair attempt sau vẫn hit tầng 1+2
Tầng 3  tool results + correction text          ← luôn append CUỐI, không chèn giữa
```

- Điểm mấu chốt: **project memory (L2) chính là tầng 1 của cache** — block ổn định
  nhất, đặt đầu prompt → mọi task trong project cùng chia sẻ cache của nó.
- Khắc phục điểm yếu repair cũ: repair-context hiện nhét errors vào block *giữa*
  prompt (phá cache); thiết kế mới correction luôn append cuối.
- Dùng `context_checksums` / `context_revision` (có sẵn trong conversation-state-store)
  làm cache-validity: index version đổi → đổi `prompt_cache_key`.
- Transcript append-only = hình dạng lý tưởng cho prefix cache: round n = prefix
  y hệt round n-1 + đuôi mới.

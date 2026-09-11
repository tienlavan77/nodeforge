# Ký ức Agent và `transcript_blocks`

## Mục tiêu

Xác định cơ chế cấp ký ức cho Agent Builder trong pipeline Supervisor. Tài liệu này chốt hai tầng:

1. **Tầng làm ngay** — nối `transcript_blocks` vào mọi round, kể cả round repair. Không cần tool, không đổi schema envelope.
2. **Tầng chờ tool xong** — agentic tool loop để Agent tự pull content qua bốn tool Tool Lab.

Tool chưa xây xong nên **chưa kết nối vào Supervisor**, R1, R2, R3 hay pipeline production. Phần tool trong tài liệu này là thiết kế, không phải phạm vi thi công hiện tại.

## Vấn đề: Agent stateless

### Bằng chứng

`backend/src/modules/agent/provider-adapters/request-builder.js:2`

```js
export function buildMessages(payload = {}) {
  if (!payload.stable_context && !payload.dynamic_context) return [{ role: "user", content: payload.text ?? JSON.stringify(payload) }];
  ...
}
```

Mỗi request là một conversation mới, chỉ có `role: "user"`. Không replay history.

`backend/src/modules/agent/provider-adapters/anthropic-adapter.js:8` — một `fetch`, trả `tool_use` đầu tiên rồi kết thúc. Không có gì execute tool, không append `tool_result`, không gọi lại provider.

`backend/src/modules/supervisor/sender-worker.js:41` lưu `last_provider_response_id` vào conversationStateStore, nhưng không adapter nào gửi nó đi (grep `previous_response_id` trong `provider-adapters/` ra rỗng).

`backend/src/modules/supervisor/sender-worker.js:33`

```js
if (type === "code_provide" || expected === "submit_code_response") return stage1AgentTools.filter((tool) => tool.name === "submit_code_response");
```

R3/R4 chỉ thấy đúng một tool.

`backend/src/modules/workflows/stage1-agent-tools.js` chỉ lọc các response tool (`code_needed`, `planning`, `submit_code_response`, `patch_repair_response`, `usage_needed`, `no_wiring_needed`). Bốn retrieval tool không nằm trong danh sách gửi đi.

### Hệ quả

Agent không biết R3 có gì, không biết mình đã submit gì. `transcript_blocks` với `full_request_ref` / `full_response_ref` hiện chỉ có giá trị audit, vì Agent không có tool để đọc Protocol Storage.

## Bốn chỗ đứt của tool layer

Tool đã build đúng; đường nối thì chưa.

### Đứt 1 — registry thiếu tool

`backend/src/modules/supervisor/production-runtime.js:35`

```js
const toolRegistry = protocolStorage?.get && fileService?.readForIndex ? createForgeToolRegistry({ protocolStorage, fileService }) : {};
```

Theo `backend/src/tools/index.js:30`, `search_code` chỉ đăng ký khi có `codeSearch?.search`, `read_code` chỉ khi `enableReadCode: true`. Runtime thật **chỉ có 2 tool**: `read_transcript_blocks` và `select_code_graph_candidates`.

### Đứt 2 — `toolRegistry` bị rơi

`backend/scripts/start-control-api.mjs:49` truyền `toolRegistry: stores.toolRegistry` vào `createSupervisorRoundController`, nhưng `backend/src/modules/supervisor/round-controller.js:5` không có tham số đó. Bị bỏ silently.

### Đứt 3 — request không mang tool

Payload R không có field `tools` retrieval. Xem Đứt 1 và `stage1-agent-tools.js`.

### Đứt 4 — không có agentic loop

Adapter trả `tool_use` rồi dừng. Kể cả nối được ba chỗ trên, Agent gọi `read_code` sẽ không ai trả lời.

## Hai loại ký ức

```text
Ký ức phiên (episodic)
  read_transcript_blocks
  → đọc R1..R3, RS1..RS3 từ Protocol Storage
  → Agent biết mình đã được giao gì, đã submit gì, đã sai ở đâu

Ký ức làm việc (working)
  search_code, read_code, select_code_graph_candidates
  → đọc codebase tại thời điểm Agent gọi
  → luôn fresh, không bao giờ stale
```

Ưu điểm của pull: `read_code` đọc từ disk lúc Agent gọi, nên `CHECKSUM_MISMATCH` do context stale tự hết là vấn đề.

## TẦNG 1 — `transcript_blocks` (làm ngay)

### Đã được nối sẵn

`backend/src/modules/supervisor/round-controller.js:218`

```js
transcript_blocks: transcriptBlocks.map((block) => ({ ...block })),
```

Mọi request đều mang, không phân biệt round. Yêu cầu "bất kể vòng nào" đã đúng về cấu trúc. Cái hỏng là **nội dung**, ở ba chỗ dưới.

### Chính sách: index tất cả, gate nội dung

```text
MỤC LỤC  → tất cả round, luôn luôn, không gate
NỘI DUNG → gate bằng in_window + budget + tool (khi tool xong)
```

Block không chứa content, chỉ là con trỏ — khoảng 150–200 byte/round. Mười round chưa tới 2 KB, không đáng kể so với một `current_content`.

Ba lý do phải index đủ:

1. Agent stateless → `transcript_blocks` là mục lục duy nhất về quá khứ. Nếu chỉ đưa round N-1, Agent không biết round 1..N-2 tồn tại — không phải "không đọc được" mà là "không biết để đọc".
2. Repair cần round không liền kề — sửa R5 có thể cần lý do chọn file ở R2, submission gốc ở R3.
3. Chi phí gần bằng 0.

`backend/src/tools/read-transcript-blocks.js:47` đã implement đúng ngữ nghĩa này:

```js
if (!block.in_window) return result;
```

Block ngoài window vẫn trả `block_id`, `round`, `instruction`, `response_summary` — Agent thấy *có* round đó và nó là gì, chỉ không expand được content.

### Sửa 1 — append block cho round 3 và round repair

`appendTranscriptBlock` chỉ được gọi tại `round-controller.js:35` (round 1) và `:44` (round 2). Nhánh round 3 (`:70`) không gọi. Round 4, 5 chưa tồn tại.

Hệ quả hôm nay: mọi R3 gửi đi với `transcript_blocks` chỉ chứa `round-1`, `round-2`.

Sửa: append block khi **nhận response**, cho mọi round, kể cả repair. Không append lúc build request vì `full_response_ref` chưa tồn tại.

```text
build R4  → transcript_blocks = [round-1, round-2, round-3]
RS4 về    → append round-4
build R5  → transcript_blocks = [round-1, round-2, round-3, round-4]
```

Block của round hiện tại không tự tham chiếu; Agent biết round hiện tại qua `step_id`.

### Sửa 2 — làm giàu `response_summary`

`round-controller.js:144`

```js
response_summary: String(response?.type ?? response?.payload?.type ?? "response")
```

Ra đúng chuỗi `"submit_code_response"`. Nếu index tất cả round nhưng gate content, thì với round ngoài window **summary là tất cả những gì Agent biết**.

Làm giàu theo round:

```text
round 1 (code_needed)          → "requested N files, phases: ..."
round 2 (planning)             → "plan approved: 3 MODIFY, 1 NEW, 2 READ_ONLY"
round 3 (submit_code_response) → "submitted 3 files, 1 missing"
round 4+ (repair)              → "valid 3, invalid 1: CHECKSUM_MISMATCH(Header.jsx)"
```

Block repair thêm `outcome`:

```json
{
  "block_id": "round-4",
  "round": 4,
  "round_kind": "repair",
  "repair_round": 1,
  "instruction": "code_provide",
  "response_summary": "valid 3, invalid 1: CHECKSUM_MISMATCH",
  "outcome": {
    "valid_count": 3,
    "invalid_count": 1,
    "codes": ["CHECKSUM_MISMATCH"],
    "invalid_paths": ["frontend/src/components/Header.jsx"]
  },
  "full_request_ref": "task/FORGE-UI-052/round_4/request",
  "full_response_ref": "task/FORGE-UI-052/round_4/response",
  "in_window": true,
  "cacheable": false
}
```

Chỉ số đếm và mã lỗi — không nhét content vào block, giữ đúng vai trò mục lục.

### Sửa 3 — `in_window` phải là policy thật

`round-controller.js` đang hardcode `in_window: true`. Cờ này **đã có consumer thật**, không phải để dành cho tương lai: `openai-adapter.js:16` gọi `resolveTranscript`, và `openai-transcript-resolver.js` phân nhánh theo cờ:

```js
if (!block.in_window) {
  return Object.freeze({ ..., text: oneLine(block.response_summary) });
}
const [request, response] = await Promise.all([storage.get(block.full_request_ref), storage.get(block.full_response_ref)]);
```

Nghĩa là `in_window: true` = hai lần đọc Protocol Storage + đẩy full payload vào message. Hardcode `true` cho mọi round hôm nay đang làm phình token thật, và làm mất thông tin ở chiều ngược lại vì `response_summary` chỉ là type thô.

```text
LUÔN trong window
  round hiện tại - 1
  round hiện tại - 2
  round 2          (chứa approved plan rationale)
  origin_round     (round 3 với mọi repair)

NGOÀI window
  các round repair cũ đã bị vượt
  round 1 khi đã qua round 4
  round_kind = "planning_retry"   (ref bị ghi đè — xem dưới)
```

Ví dụ ở R6 (`repair_round: 3`, `origin_round: 3`):

```text
round-1  in_window: false   (chỉ còn summary)
round-2  in_window: true    (plan)
round-3  in_window: true    (origin)
round-4  in_window: false   (repair cũ, đã bị R5 vượt)
round-5  in_window: true    (liền trước)
```

Tất cả vẫn **có mặt** trong `transcript_blocks`. Chỉ khác cờ.

### Sửa 4 — dedup key theo `request_id`

`round-controller.js:137`

```js
if (transcriptBlocks.some((block) => block.round === roundNumber)) return;
```

R4, R5 có số round unique nên vẫn đúng. Nhưng R2 có nhánh lặp: `response.type === "code_needed"` ở round 2 thì request lại round 2 mà không tăng round (`round-controller.js:45`). Block thứ hai bị chặn, `response_summary` giữ nguyên của lần đầu — stale.

Đổi key:

```js
if (transcriptBlocks.some((block) => block.request_id === requestId)) return;
```

### Hệ quả của Sửa 4 — ref của round lặp bị ghi đè

Index đủ hai lần R2 làm lộ ra một xung đột có từ trước: `requestForRound` sinh ref từ **số round thuần**, và `protocolStorage.save(..., { replace: true })` ghi đè.

```text
round-2    full_request_ref: task/{id}/round_2/request
round-2.2  full_request_ref: task/{id}/round_2/request   ← trùng
```

Cả `round_2/request` (lần build thứ hai đè lần một) lẫn `round_2/response` (`persistAgentResponse` bên SW) đều chỉ giữ bản cuối. Resolver expand block `round-2` — summary nói `code_needed: requested 2 file(s)` — bằng payload của round **planning**.

Trước Sửa 4 block thứ hai bị dedup nuốt nên chỉ còn một block, xung đột không quan sát được. Đây là lỗi có sẵn, không phải lỗi mới.

Ba hướng đã cân:

```text
1. in_window = false cho round_kind "planning_retry"
   1 dòng, nằm gọn trong round-controller.js, giữ convention ref phẳng.
   Resolver chỉ dùng response_summary (vốn chính xác) thay vì expand nhầm.

2. ref có attempt: round_2/attempt_2/request
   đúng bản chất, nhưng phá convention phẳng task/{id}/round_{n}/...
   đã chốt cho repair round, và đụng response-persistence.js.

3. để nguyên
   chấp nhận block planning_retry expand ra payload sai.
```

**Chốt hướng 1.** Block mà ref trỏ sai payload thì không expand còn hơn expand sai; summary của nó đã đủ thông tin. `full_request_ref` / `full_response_ref` vẫn **phải có mặt** trên block vì `request.schema.json` để trong `required` — chỉ là không được resolve.

Hướng 2 để ngỏ: nếu sau này cần audit chính xác từng lần trao đổi của R2 lặp, phải đổi convention ref ở cả `round-controller.js` lẫn `response-persistence.js` cùng lúc, không làm một phía.

R4, R5 không dính lỗi này — mỗi round repair có số round riêng nên ref riêng.

### Prompt cache — giữ append-only, bất biến

`request-builder.js:7` có `cache_control: { type: "ephemeral" }`. Cache đánh theo prefix; `transcript_blocks` chỉ thêm vào cuối nên prefix ổn định qua các round.

Điều kiện để cache hit:

```text
transcript_blocks đặt TRƯỚC phần volatile
repair_context, invalid, failed_operations đặt SAU
không bao giờ mutate block cũ
```

Policy `in_window` trượt sẽ đổi cờ block cũ mỗi round và phá prefix. Chốt: **tính `in_window` một lần lúc append block, không recalculate về sau**. Block đã ghi là bất biến. Muốn gate theo round hiện tại thì để tool tự suy ra từ `block.round` + `context.execution_scope.round`, không sửa block.

### Field cần thêm vào block

```json
{
  "request_id": "...",
  "response_id": "...",
  "round_kind": "initial | planning_retry | repair",
  "closed_at": "2026-09-06T..."
}
```

`request_id` cho dedup. `round_kind` để Agent phân biệt round repair mà không suy luận từ số. `closed_at` để audit.

### Phạm vi thi công Tầng 1

Chủ yếu đụng `backend/src/modules/supervisor/round-controller.js`:

```text
1. gọi appendTranscriptBlock ở nhánh round 3
2. chuẩn bị nhánh round 4+ (khi repair round có)
3. đổi dedup key sang request_id
4. làm giàu response_summary theo round type
5. tính in_window một lần, bất biến
6. thêm request_id, response_id, round_kind, repair_round, outcome, closed_at vào block
7. in_window = false cho round_kind "planning_retry" (hệ quả mục 3)
```

Không đụng tool, adapter, sender-worker.

**Ngoài dự kiến ban đầu:** phải sửa hai file schema. `request.schema.json` khai báo `$defs/transcript_blocks` với `additionalProperties: false` và đúng 8 field, nên block emit ra theo mục 6 sẽ mâu thuẫn schema. Đã thêm 6 field dạng **optional** (`required` giữ nguyên 8 field cũ) — block 8-field cũ vẫn valid, field lạ vẫn bị reject. `anthropic.schema.json` là schema tham khảo, không code nào đọc, sửa để ghi lại quyết định `in_window` bất biến.

**Rủi ro — đánh giá lại:** bản đầu tài liệu này ghi "block chỉ là metadata, Agent hiện chưa có tool đọc content, nên thay đổi chưa ảnh hưởng hành vi". **Sai.** `openai-transcript-resolver.js` đang tiêu thụ `in_window` thật qua `openai-adapter.js:16`. Đổi cờ là đổi hành vi: block ra khỏi window sẽ không còn bị fetch full payload từ Protocol Storage nữa, chỉ còn `oneLine(response_summary)`. Với round 1/2/3 cờ vẫn `true` nên pipeline hiện tại không đổi; chỗ đổi hành vi duy nhất là `planning_retry` — và đó là đổi từ "expand sai payload" sang "không expand", tức là sửa lỗi.

## TẦNG 2 — agentic tool loop (chờ tool xong)

### Vòng lặp

```text
SW nhận job R4
  ↓
build messages + tools + tool_context
  ↓
gọi provider
  ↓
tool_use = submit_code_response
  → kết thúc, publish agent.response.received về Supervisor
  ↓
tool_use = read_transcript_blocks / search_code / read_code / select_code_graph_candidates
  → toolRegistry[name].execute(input, tool_context)
  → append assistant tool_use + user tool_result vào messages
  → gọi provider lại
  ↓
lặp cho đến submit_code_response hoặc chạm giới hạn
```

### Loop đặt trong Sender Worker

```text
Hợp đồng SW ↔ Supervisor không đổi
  một request vào → một agent.response.received ra

Protocol Storage không đổi
  task/{id}/round_4/request
  task/{id}/round_4/response

Supervisor không cần biết Agent đã gọi bao nhiêu tool
  → hub-and-spoke giữ nguyên
```

Không đặt trong adapter — adapter đang là HTTP thuần, provider-specific. Không tạo worker mới — thêm moving part không cần thiết.

### Messages phải provider-neutral

`buildMessages(payload)` hiện build từ đầu mỗi lần. Cần accumulator ở tầng SW:

```text
SW giữ messages[]
  → adapter nhận messages[] (không phải payload thô)
  → adapter map sang format Anthropic / OpenAI
  → adapter trả tool_use đã normalize
```

Anthropic nhét `tool_result` trong `role: "user"` content array; OpenAI dùng message `role: "tool"` riêng. Accumulator phải nằm **trên** adapter.

### `tool_context` Node phải cấp

`read-transcript-blocks.js:12` đọc từ `context`, không phải `input`:

```js
const taskId = context.task_id ?? context.taskId;
const capabilities = new Set(context.capabilities ?? []);
const allowedFiles = new Set(context.allowed_file_paths ?? context.allowedFilePaths ?? []);
```

`checkRetrievalBudget` đọc `context.context_budget`. R4 phải mang:

```json
{
  "tool_context": {
    "task_id": "FORGE-UI-052",
    "execution_scope": { "task_id": "FORGE-UI-052", "supervisor_id": "...", "round": 4 },
    "capabilities": ["read_transcript_blocks", "select_code_graph_candidates", "search_code", "read_code"],
    "transcript_blocks": [],
    "allowed_file_paths": [],
    "context_budget": { "max_bytes": 200000, "max_calls": 20, "used_bytes": 0, "used_calls": 0 }
  }
}
```

`allowed_file_paths` là biên bảo mật — lấy từ `approvedPlan` (path có action `NEW` / `MODIFY` / `READ_ONLY`). Ngoài danh sách đó, `read-transcript-blocks.js:27` tự chặn.

`capabilities` là chỗ Node cấp quyền theo round — R1/R2 có thể không cấp `read_code`, R3/R4 cấp đủ. Đây là policy, không hardcode.

### Governance đã có sẵn

```text
backend/src/tools/tool-authorization.js:4      authorizeTool — capability + task_id
backend/src/tools/retrieval-governance.js:8    assertExecutionScope — TOOL_SCOPE_INVALID
backend/src/tools/retrieval-governance.js:13   checkRetrievalBudget — CONTEXT_BUDGET_EXCEEDED
backend/src/tools/retrieval-governance.js:25   recordRetrieval — audit_retrieval callback
```

Mặc định `DEFAULT_MAX_CALLS = 20`, `DEFAULT_MAX_BYTES = 200000`.

### Bốn chỗ phải nối khi tool xong

```text
1. production-runtime.js:35   → truyền codeSearch, enableReadCode: true
2. round-controller.js:5      → nhận toolRegistry, emit tools[] + tool_context
3. stage1-agent-tools.js / sender-worker.js:33 → code_provide gửi submit_code_response + retrieval tools
4. sender-worker.js:15        → thêm tool loop quanh adapter.send; adapter nhận messages[]
```

### Budget ba lớp

```text
Lớp 1 — retrieval budget (đã có)
  checkRetrievalBudget: max_bytes 200000, max_calls 20

Lớp 2 — turn budget (chưa có)
  max_tool_turns mỗi round, ví dụ 12
  vượt → agent.response.failed với code TOOL_TURN_LIMIT

Lớp 3 — round budget (chưa có)
  max_repair_rounds, ví dụ 2
  vượt → Supervisor chuyển NEEDS_HUMAN_REVIEW (state đã có trong SUPERVISOR_STATES)
```

Nối `recordRetrieval`'s `context.audit_retrieval` vào `projectLogger` để mỗi lần Agent đọc gì đều có log — đúng nguyên tắc không âm thầm.

### Tool turn không được vô hình

Nếu chỉ lưu `round_4/response` cuối cùng, ta mất dấu Agent đã đọc gì, mấy lần, tốn bao nhiêu byte. Lưu thêm:

```text
task/{task_id}/round_4/turns          (hoặc event log)
  ├─ turn 1: tool_use read_code + tool_result summary
  ├─ turn 2: tool_use read_transcript_blocks + summary
  └─ turn 3: submit_code_response
```

Chỉ lưu tóm tắt + ref, không lưu full `tool_result` (đã nằm trong Protocol Storage/disk).

## Hệ quả lên repair round R4/R5

### Khi Agent CÓ working memory

```text
current_content của MODIFY invalid
  → Agent gọi read_code(path), lấy bản fresh hơn cả push

READ_ONLY content
  → Agent gọi read_code, nếu path nằm trong allowed_file_paths

locked_new_files content
  → Agent gọi read_transcript_blocks({ rounds: [3], include: "response" })
  → RS3 đã được SW ghi ở task/{id}/round_3/response
  → với NEW valid, submitted_content === proposed_content
  → khôi phục được, không cần push
```

R4 chỉ còn push những gì Agent không tự lấy được:

```json
{
  "type": "code_provide",
  "step_id": 4,
  "round_kind": "repair",
  "repair_round": 1,
  "origin_round": 3,
  "source_round": 3,
  "approved_plan": [],
  "valid_paths": [],
  "invalid_paths": [],
  "repair_context": {},
  "failed_operations": {},
  "before_checksums": { "frontend/src/components/Header.jsx": "sha256:..." },
  "tool_context": {},
  "transcript_blocks": [],
  "instruction_blocks": [],
  "expected_output": { "type": "submit_code_response", "transport": "function_tool" }
}
```

### Ranh giới — ba thứ vẫn phải push

```text
1. before_checksum
   → giá trị contract Agent phải echo lại
   → Node phải ấn định; nếu Agent read_code rồi tự tính sẽ race với lúc MW verify

2. errors + failed_operations
   → Agent không suy ra được MW đã reject vì sao
   → read_transcript_blocks cho thấy patch cũ, không cho thấy lý do hỏng

3. valid_paths (lock list)
   → policy của Supervisor, không phải dữ liệu trên disk
```

Nguyên tắc: **push fact nhỏ và ràng buộc, pull content lớn.**

### Rủi ro của pull

Agent có thể *không* gọi tool. `repair-correction` phải ra lệnh rõ:

```text
Before submitting, call read_code for every path in invalid_paths to obtain
the current source. Do not reuse content from memory of previous rounds.
```

MW vẫn là cổng chặn cuối: Agent submit mà không đọc → `before_checksum` sai → `CHECKSUM_MISMATCH` → repair tiếp. Hệ thống tự bảo vệ, không cần tin Agent.

### Khi Agent CHƯA có working memory (hiện tại)

R4 phải self-contained, push full content. Ma trận theo `action × error code`:

**MODIFY invalid** — luôn gửi:

```json
{
  "path": "frontend/src/components/Header.jsx",
  "action": "MODIFY",
  "format": "structured_patch",
  "exists": true,
  "content": "<current_content đầy đủ, đọc lại lúc build R4>",
  "current_content": "<như trên>",
  "before_checksum": "sha256:...",
  "repair_reason": "CHECKSUM_MISMATCH",
  "errors": [],
  "failed_operations": []
}
```

`before_checksum` phải tính từ **chính chuỗi `content` đó**, cùng một lần đọc. Copy `current_content` của MW rồi tính checksum riêng có thể làm hai giá trị lệch nhau.

`failed_operations` — chỉ operation hỏng, không phải cả patch:

```json
{
  "failed_operations": [
    { "operation_index": 2, "op": "replace_range", "expected_content": "đoạn agent đã gửi", "code": "EXPECTED_CONTENT_NOT_FOUND", "message": "..." }
  ]
}
```

`submitted_content` đầy đủ chỉ gửi khi lỗi là cấu trúc: `PATCH_STRUCTURE_INVALID`, `SUBMISSION_FORMAT_UNSUPPORTED`, `MISSING_BEFORE_CHECKSUM`, `INVALID_NEW_FILE_CHECKSUM`.

**NEW invalid**

```text
MISSING_SUBMISSION        → content: null; chỉ cần plan entry + instruction
NEW_FILE_ALREADY_EXISTS   → BẮT BUỘC gửi current_content của file đang tồn tại
PATCH_STRUCTURE_INVALID   → gửi submitted_content đầy đủ (không có current_content)
```

**READ_ONLY** — phải gửi lại toàn bộ tập READ_ONLY, vì Agent không còn nội dung nó thấy ở R3. Giống cách R3 làm tại `round-controller.js:58`.

**`locked_new_files`** — bắt buộc kèm `content`. MW chạy `filesystem_write: false` (`materializer-worker.js`), nên NEW valid ở R3 chưa được ghi disk; `fullContextProvider` đọc từ disk sẽ trả ENOENT. Nội dung đó không tồn tại ở đâu khác.

**Không gửi**: `valid` full object, `proposed_content` của valid (trừ `locked_new_files`), `verification` flags, `patch_id`, `valid_patches` / `invalid_patches` legacy.

**Size guard** — `current_content` của MODIFY invalid **không bao giờ truncate**. Cắt là Agent không build được patch, sinh repair loop vô nghĩa. Vượt ngưỡng thì set `escalation: "REPAIR_CONTEXT_TOO_LARGE"` và Supervisor chuyển `NEEDS_HUMAN_REVIEW` — không âm thầm cắt.

Thứ tự ưu tiên khi buộc phải cắt:

```text
1. READ_ONLY không liên quan                → cắt trước
2. locked_new_files lớn                    → cắt, giữ path + after_checksum
3. submitted_content / failed_operations   → cắt
4. current_content của MODIFY invalid      → KHÔNG BAO GIỜ
```

## Vấn đề phụ: `transcript` array trong RAM

`round-controller.js:9` — `transcript` khác `transcriptBlocks`. Nó giữ **full payload** trong memory:

```js
transcript.push({ type: "request", round: roundNumber, request_id: envelope.request_id, payload: envelope.payload });
```

(`round-controller.js:234`)

Không gửi cho Agent, không persist. Với R4, R5 nó phình theo mỗi round vì payload chứa full file content. Đây là memory leak tiềm ẩn khi repair chain dài — nội dung đó đã nằm trong Protocol Storage, giữ bản thứ hai trong RAM là trùng lặp. Nên giới hạn hoặc bỏ.

## Thứ tự triển khai

```text
1. appendTranscriptBlock cho round 3 + round repair        ← làm ngay, độc lập
2. dedup key → request_id; in_window bất biến; field mới   ← làm ngay
3. làm giàu response_summary + outcome                     ← làm ngay
   --- chờ tool xong ---
4. nối toolRegistry: production-runtime → round-controller → payload
5. nới sender-worker.js:33 cho code_provide
6. đổi adapter nhận messages[] thay vì tự buildMessages
7. thêm tool loop + turn budget + audit trong Sender Worker
8. rút gọn R4 payload sang mô hình push-fact / pull-content
```

Bước 8 phải làm sau cùng. Rút gọn payload trước khi có loop thì Agent không có ký ức **và** không có content — hỏng cả hai đường.

Hai mô hình không loại nhau: push là fallback an toàn khi chưa có loop, pull là tối ưu khi loop đã chạy.

## Kiểm chứng

Tầng 1 (không cần tool):

1. Chạy một task qua `backend/scripts/start-control-api.mjs`, để pipeline đi hết R1 → R2 → R3.
2. Đọc `task/{task_id}/round_3/request` trong Protocol Storage, kiểm tra `payload.transcript_blocks` chứa đủ `round-1`, `round-2` (hiện tại thiếu `round-2` ở một số nhánh lặp và **không bao giờ** có `round-3`).
3. Sau khi sửa, R4 (khi repair round có) phải chứa `round-1` .. `round-3`, mỗi block có `request_id`, `round_kind`, `closed_at`, `response_summary` không phải chỉ là type thô.
4. Kiểm tra block cũ **bất biến** giữa hai request liên tiếp (diff JSON) — điều kiện prompt cache hit.
5. Test hiện có không được vỡ: `node --test backend/tests/tools/*.test.js` (bốn tool có test riêng) và `node --test backend/tests/unit/stage1-fixture.test.js`.

Tầng 2 (khi tool xong): chạy lại các script Tool Lab có sẵn để xác nhận registry đủ 4 tool —
`backend/scripts/test-read-transcript-tool.mjs`, `test-search-code-tool.mjs`, `test-read-code-tool.mjs`, `test-select-code-graph-candidates-tool.mjs`.

## Ghi chú phạm vi

Tài liệu này không kèm thay đổi code nào ngoài `round-controller.js` ở Tầng 1. Việc nối tool vào Supervisor bị hoãn tới khi tool xây xong, theo đúng chỉ đạo hiện tại.

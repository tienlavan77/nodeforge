<!-- Preserves a quoted historical document section so engineers can read archived examples without treating them as new executable definitions; removing quote prefixes reconstructs the exact original bytes. -->
> ```
> 
> Nghĩa là `in_window: true` = hai lần đọc Protocol Storage + đẩy full payload vào message. Hardcode `true` cho mọi round hôm nay đang làm phình token thật, và làm mất thông tin ở chiều ngược lại vì `response_summary` chỉ là type thô.
> 
> ```text
> LUÔN trong window
>   round hiện tại - 1
>   round hiện tại - 2
>   round 2          (chứa approved plan rationale)
>   origin_round     (round 3 với mọi repair)
> 
> NGOÀI window
>   các round repair cũ đã bị vượt
>   round 1 khi đã qua round 4
>   round_kind = "planning_retry"   (ref bị ghi đè — xem dưới)
> ```
> 
> Ví dụ ở R6 (`repair_round: 3`, `origin_round: 3`):
> 
> ```text
> round-1  in_window: false   (chỉ còn summary)
> round-2  in_window: true    (plan)
> round-3  in_window: true    (origin)
> round-4  in_window: false   (repair cũ, đã bị R5 vượt)
> round-5  in_window: true    (liền trước)
> ```
> 
> Tất cả vẫn **có mặt** trong `transcript_blocks`. Chỉ khác cờ.
> 
> ### Sửa 4 — dedup key theo `request_id`
> 
> `round-controller.js:137`
> 
> ```js
> if (transcriptBlocks.some((block) => block.round === roundNumber)) return;
> ```
> 
> R4, R5 có số round unique nên vẫn đúng. Nhưng R2 có nhánh lặp: `response.type === "code_needed"` ở round 2 thì request lại round 2 mà không tăng round (`round-controller.js:45`). Block thứ hai bị chặn, `response_summary` giữ nguyên của lần đầu — stale.
> 
> Đổi key:
> 
> ```js
> if (transcriptBlocks.some((block) => block.request_id === requestId)) return;
> ```
> 
> ### Hệ quả của Sửa 4 — ref của round lặp bị ghi đè
> 
> Index đủ hai lần R2 làm lộ ra một xung đột có từ trước: `requestForRound` sinh ref từ **số round thuần**, và `protocolStorage.save(..., { replace: true })` ghi đè.
> 
> ```text
> round-2    full_request_ref: task/{id}/round_2/request
> round-2.2  full_request_ref: task/{id}/round_2/request   ← trùng
> ```
> 
> Cả `round_2/request` (lần build thứ hai đè lần một) lẫn `round_2/response` (`persistAgentResponse` bên SW) đều chỉ giữ bản cuối. Resolver expand block `round-2` — summary nói `code_needed: requested 2 file(s)` — bằng payload của round **planning**.
> 
> Trước Sửa 4 block thứ hai bị dedup nuốt nên chỉ còn một block, xung đột không quan sát được. Đây là lỗi có sẵn, không phải lỗi mới.
> 
> Ba hướng đã cân:
> 
> ```text
> 1. in_window = false cho round_kind "planning_retry"
>    1 dòng, nằm gọn trong round-controller.js, giữ convention ref phẳng.
>    Resolver chỉ dùng response_summary (vốn chính xác) thay vì expand nhầm.
> 
> 2. ref có attempt: round_2/attempt_2/request
>    đúng bản chất, nhưng phá convention phẳng task/{id}/round_{n}/...
>    đã chốt cho repair round, và đụng response-persistence.js.
> 
> 3. để nguyên
>    chấp nhận block planning_retry expand ra payload sai.
> ```
> 
> **Chốt hướng 1.** Block mà ref trỏ sai payload thì không expand còn hơn expand sai; summary của nó đã đủ thông tin. `full_request_ref` / `full_response_ref` vẫn **phải có mặt** trên block vì `request.schema.json` để trong `required` — chỉ là không được resolve.
> 
> Hướng 2 để ngỏ: nếu sau này cần audit chính xác từng lần trao đổi của R2 lặp, phải đổi convention ref ở cả `round-controller.js` lẫn `response-persistence.js` cùng lúc, không làm một phía.
> 
> R4, R5 không dính lỗi này — mỗi round repair có số round riêng nên ref riêng.
> 
> ### Prompt cache — giữ append-only, bất biến
> 
> `request-builder.js:7` có `cache_control: { type: "ephemeral" }`. Cache đánh theo prefix; `transcript_blocks` chỉ thêm vào cuối nên prefix ổn định qua các round.
> 
> Điều kiện để cache hit:
> 
> ```text
> transcript_blocks đặt TRƯỚC phần volatile
> repair_context, invalid, failed_operations đặt SAU
> không bao giờ mutate block cũ
> ```
> 
> Policy `in_window` trượt sẽ đổi cờ block cũ mỗi round và phá prefix. Chốt: **tính `in_window` một lần lúc append block, không recalculate về sau**. Block đã ghi là bất biến. Muốn gate theo round hiện tại thì để tool tự suy ra từ `block.round` + `context.execution_scope.round`, không sửa block.
> 
> ### Field cần thêm vào block
> 
> ```json
> {
>   "request_id": "...",
>   "response_id": "...",
>   "round_kind": "initial | planning_retry | repair",
>   "closed_at": "2026-09-06T..."
> }
> ```
> 
> `request_id` cho dedup. `round_kind` để Agent phân biệt round repair mà không suy luận từ số. `closed_at` để audit.
> 
> ### Phạm vi thi công Tầng 1
> 
> Chủ yếu đụng `backend/src/modules/supervisor/round-controller.js`:
> 
> ```text
> 1. gọi appendTranscriptBlock ở nhánh round 3
> 2. chuẩn bị nhánh round 4+ (khi repair round có)
> 3. đổi dedup key sang request_id
> 4. làm giàu response_summary theo round type
> 5. tính in_window một lần, bất biến
> 6. thêm request_id, response_id, round_kind, repair_round, outcome, closed_at vào block
> 7. in_window = false cho round_kind "planning_retry" (hệ quả mục 3)
> ```
> 
> Không đụng tool, adapter, sender-worker.
> 
> **Ngoài dự kiến ban đầu:** phải sửa hai file schema. `request.schema.json` khai báo `$defs/transcript_blocks` với `additionalProperties: false` và đúng 8 field, nên block emit ra theo mục 6 sẽ mâu thuẫn schema. Đã thêm 6 field dạng **optional** (`required` giữ nguyên 8 field cũ) — block 8-field cũ vẫn valid, field lạ vẫn bị reject. `anthropic.schema.json` là schema tham khảo, không code nào đọc, sửa để ghi lại quyết định `in_window` bất biến.
> 
> **Rủi ro — đánh giá lại:** bản đầu tài liệu này ghi "block chỉ là metadata, Agent hiện chưa có tool đọc content, nên thay đổi chưa ảnh hưởng hành vi". **Sai.** `openai-transcript-resolver.js` đang tiêu thụ `in_window` thật qua `openai-adapter.js:16`. Đổi cờ là đổi hành vi: block ra khỏi window sẽ không còn bị fetch full payload từ Protocol Storage nữa, chỉ còn `oneLine(response_summary)`. Với round 1/2/3 cờ vẫn `true` nên pipeline hiện tại không đổi; chỗ đổi hành vi duy nhất là `planning_retry` — và đó là đổi từ "expand sai payload" sang "không expand", tức là sửa lỗi.
> 
> ## TẦNG 2 — agentic tool loop (chờ tool xong)
> 
> ### Vòng lặp
> 
> ```text
> SW nhận job R4
>   ↓
> build messages + tools + tool_context
>   ↓
> gọi provider
>   ↓
> tool_use = submit_code_response
>   → kết thúc, publish agent.response.received về Supervisor
>   ↓
> tool_use = read_transcript_blocks / search_code / read_code / select_code_graph_candidates
>   → toolRegistry[name].execute(input, tool_context)
>   → append assistant tool_use + user tool_result vào messages
>   → gọi provider lại
>   ↓
> lặp cho đến submit_code_response hoặc chạm giới hạn
> ```
> 
> ### Loop đặt trong Sender Worker
> 
> ```text
> Hợp đồng SW ↔ Supervisor không đổi
>   một request vào → một agent.response.received ra
> 
> Protocol Storage không đổi
>   task/{id}/round_4/request
>   task/{id}/round_4/response
> 
> Supervisor không cần biết Agent đã gọi bao nhiêu tool
>   → hub-and-spoke giữ nguyên
> ```
> 
> Không đặt trong adapter — adapter đang là HTTP thuần, provider-specific. Không tạo worker mới — thêm moving part không cần thiết.
> 
> ### Messages phải provider-neutral
> 
> `buildMessages(payload)` hiện build từ đầu mỗi lần. Cần accumulator ở tầng SW:
> 
> ```text
> SW giữ messages[]
>   → adapter nhận messages[] (không phải payload thô)
>   → adapter map sang format Anthropic / OpenAI
>   → adapter trả tool_use đã normalize
> ```
> 
> Anthropic nhét `tool_result` trong `role: "user"` content array; OpenAI dùng message `role: "tool"` riêng. Accumulator phải nằm **trên** adapter.
> 
> ### `tool_context` Node phải cấp
> 
> `read-transcript-blocks.js:12` đọc từ `context`, không phải `input`:
> 
> ```js
> const taskId = context.task_id ?? context.taskId;
> const capabilities = new Set(context.capabilities ?? []);
> const allowedFiles = new Set(context.allowed_file_paths ?? context.allowedFilePaths ?? []);
> ```
> 
> `checkRetrievalBudget` đọc `context.context_budget`. R4 phải mang:
> 
> ```json
> 
<!-- Preserves a quoted historical document section so engineers can read archived examples without treating them as new executable definitions; removing quote prefixes reconstructs the exact original bytes. -->
> # Ký ức Agent và `transcript_blocks`
> 
> ## Mục tiêu
> 
> Xác định cơ chế cấp ký ức cho Agent Builder trong pipeline Supervisor. Tài liệu này chốt hai tầng:
> 
> 1. **Tầng làm ngay** — nối `transcript_blocks` vào mọi round, kể cả round repair. Không cần tool, không đổi schema envelope.
> 2. **Tầng chờ tool xong** — agentic tool loop để Agent tự pull content qua bốn tool Tool Lab.
> 
> Tool chưa xây xong nên **chưa kết nối vào Supervisor**, R1, R2, R3 hay pipeline production. Phần tool trong tài liệu này là thiết kế, không phải phạm vi thi công hiện tại.
> 
> ## Vấn đề: Agent stateless
> 
> ### Bằng chứng
> 
> `backend/src/modules/agent/provider-adapters/request-builder.js:2`
> 
> ```js
> export function buildMessages(payload = {}) {
>   if (!payload.stable_context && !payload.dynamic_context) return [{ role: "user", content: payload.text ?? JSON.stringify(payload) }];
>   ...
> }
> ```
> 
> Mỗi request là một conversation mới, chỉ có `role: "user"`. Không replay history.
> 
> `backend/src/modules/agent/provider-adapters/anthropic-adapter.js:8` — một `fetch`, trả `tool_use` đầu tiên rồi kết thúc. Không có gì execute tool, không append `tool_result`, không gọi lại provider.
> 
> `backend/src/modules/supervisor/sender-worker.js:41` lưu `last_provider_response_id` vào conversationStateStore, nhưng không adapter nào gửi nó đi (grep `previous_response_id` trong `provider-adapters/` ra rỗng).
> 
> `backend/src/modules/supervisor/sender-worker.js:33`
> 
> ```js
> if (type === "code_provide" || expected === "submit_code_response") return stage1AgentTools.filter((tool) => tool.name === "submit_code_response");
> ```
> 
> R3/R4 chỉ thấy đúng một tool.
> 
> `backend/src/modules/workflows/stage1-agent-tools.js` chỉ lọc các response tool (`code_needed`, `planning`, `submit_code_response`, `patch_repair_response`, `usage_needed`, `no_wiring_needed`). Bốn retrieval tool không nằm trong danh sách gửi đi.
> 
> ### Hệ quả
> 
> Agent không biết R3 có gì, không biết mình đã submit gì. `transcript_blocks` với `full_request_ref` / `full_response_ref` hiện chỉ có giá trị audit, vì Agent không có tool để đọc Protocol Storage.
> 
> ## Bốn chỗ đứt của tool layer
> 
> Tool đã build đúng; đường nối thì chưa.
> 
> ### Đứt 1 — registry thiếu tool
> 
> `backend/src/modules/supervisor/production-runtime.js:35`
> 
> ```js
> const toolRegistry = protocolStorage?.get && fileService?.readForIndex ? createForgeToolRegistry({ protocolStorage, fileService }) : {};
> ```
> 
> Theo `backend/src/tools/index.js:30`, `search_code` chỉ đăng ký khi có `codeSearch?.search`, `read_code` chỉ khi `enableReadCode: true`. Runtime thật **chỉ có 2 tool**: `read_transcript_blocks` và `select_code_graph_candidates`.
> 
> ### Đứt 2 — `toolRegistry` bị rơi
> 
> `backend/scripts/start-control-api.mjs:49` truyền `toolRegistry: stores.toolRegistry` vào `createSupervisorRoundController`, nhưng `backend/src/modules/supervisor/round-controller.js:5` không có tham số đó. Bị bỏ silently.
> 
> ### Đứt 3 — request không mang tool
> 
> Payload R không có field `tools` retrieval. Xem Đứt 1 và `stage1-agent-tools.js`.
> 
> ### Đứt 4 — không có agentic loop
> 
> Adapter trả `tool_use` rồi dừng. Kể cả nối được ba chỗ trên, Agent gọi `read_code` sẽ không ai trả lời.
> 
> ## Hai loại ký ức
> 
> ```text
> Ký ức phiên (episodic)
>   read_transcript_blocks
>   → đọc R1..R3, RS1..RS3 từ Protocol Storage
>   → Agent biết mình đã được giao gì, đã submit gì, đã sai ở đâu
> 
> Ký ức làm việc (working)
>   search_code, read_code, select_code_graph_candidates
>   → đọc codebase tại thời điểm Agent gọi
>   → luôn fresh, không bao giờ stale
> ```
> 
> Ưu điểm của pull: `read_code` đọc từ disk lúc Agent gọi, nên `CHECKSUM_MISMATCH` do context stale tự hết là vấn đề.
> 
> ## TẦNG 1 — `transcript_blocks` (làm ngay)
> 
> ### Đã được nối sẵn
> 
> `backend/src/modules/supervisor/round-controller.js:218`
> 
> ```js
> transcript_blocks: transcriptBlocks.map((block) => ({ ...block })),
> ```
> 
> Mọi request đều mang, không phân biệt round. Yêu cầu "bất kể vòng nào" đã đúng về cấu trúc. Cái hỏng là **nội dung**, ở ba chỗ dưới.
> 
> ### Chính sách: index tất cả, gate nội dung
> 
> ```text
> MỤC LỤC  → tất cả round, luôn luôn, không gate
> NỘI DUNG → gate bằng in_window + budget + tool (khi tool xong)
> ```
> 
> Block không chứa content, chỉ là con trỏ — khoảng 150–200 byte/round. Mười round chưa tới 2 KB, không đáng kể so với một `current_content`.
> 
> Ba lý do phải index đủ:
> 
> 1. Agent stateless → `transcript_blocks` là mục lục duy nhất về quá khứ. Nếu chỉ đưa round N-1, Agent không biết round 1..N-2 tồn tại — không phải "không đọc được" mà là "không biết để đọc".
> 2. Repair cần round không liền kề — sửa R5 có thể cần lý do chọn file ở R2, submission gốc ở R3.
> 3. Chi phí gần bằng 0.
> 
> `backend/src/tools/read-transcript-blocks.js:47` đã implement đúng ngữ nghĩa này:
> 
> ```js
> if (!block.in_window) return result;
> ```
> 
> Block ngoài window vẫn trả `block_id`, `round`, `instruction`, `response_summary` — Agent thấy *có* round đó và nó là gì, chỉ không expand được content.
> 
> ### Sửa 1 — append block cho round 3 và round repair
> 
> `appendTranscriptBlock` chỉ được gọi tại `round-controller.js:35` (round 1) và `:44` (round 2). Nhánh round 3 (`:70`) không gọi. Round 4, 5 chưa tồn tại.
> 
> Hệ quả hôm nay: mọi R3 gửi đi với `transcript_blocks` chỉ chứa `round-1`, `round-2`.
> 
> Sửa: append block khi **nhận response**, cho mọi round, kể cả repair. Không append lúc build request vì `full_response_ref` chưa tồn tại.
> 
> ```text
> build R4  → transcript_blocks = [round-1, round-2, round-3]
> RS4 về    → append round-4
> build R5  → transcript_blocks = [round-1, round-2, round-3, round-4]
> ```
> 
> Block của round hiện tại không tự tham chiếu; Agent biết round hiện tại qua `step_id`.
> 
> ### Sửa 2 — làm giàu `response_summary`
> 
> `round-controller.js:144`
> 
> ```js
> response_summary: String(response?.type ?? response?.payload?.type ?? "response")
> ```
> 
> Ra đúng chuỗi `"submit_code_response"`. Nếu index tất cả round nhưng gate content, thì với round ngoài window **summary là tất cả những gì Agent biết**.
> 
> Làm giàu theo round:
> 
> ```text
> round 1 (code_needed)          → "requested N files, phases: ..."
> round 2 (planning)             → "plan approved: 3 MODIFY, 1 NEW, 2 READ_ONLY"
> round 3 (submit_code_response) → "submitted 3 files, 1 missing"
> round 4+ (repair)              → "valid 3, invalid 1: CHECKSUM_MISMATCH(Header.jsx)"
> ```
> 
> Block repair thêm `outcome`:
> 
> ```json
> {
>   "block_id": "round-4",
>   "round": 4,
>   "round_kind": "repair",
>   "repair_round": 1,
>   "instruction": "code_provide",
>   "response_summary": "valid 3, invalid 1: CHECKSUM_MISMATCH",
>   "outcome": {
>     "valid_count": 3,
>     "invalid_count": 1,
>     "codes": ["CHECKSUM_MISMATCH"],
>     "invalid_paths": ["frontend/src/components/Header.jsx"]
>   },
>   "full_request_ref": "task/FORGE-UI-052/round_4/request",
>   "full_response_ref": "task/FORGE-UI-052/round_4/response",
>   "in_window": true,
>   "cacheable": false
> }
> ```
> 
> Chỉ số đếm và mã lỗi — không nhét content vào block, giữ đúng vai trò mục lục.
> 
> ### Sửa 3 — `in_window` phải là policy thật
> 
> `round-controller.js` đang hardcode `in_window: true`. Cờ này **đã có consumer thật**, không phải để dành cho tương lai: `openai-adapter.js:16` gọi `resolveTranscript`, và `openai-transcript-resolver.js` phân nhánh theo cờ:
> 
> ```js
> if (!block.in_window) {
>   return Object.freeze({ ..., text: oneLine(block.response_summary) });
> }
> const [request, response] = await Promise.all([storage.get(block.full_request_ref), storage.get(block.full_response_ref)]);
> 
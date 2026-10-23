<!-- Plan nay mo rong retrieval ra ngoai repo: tool web_search/web_fetch dang ky qua MCP Forge, Node giu API key va tran chi phi. -->
# Plan: Tool search web cho agent (`web_search` / `web_fetch`)

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Agent trong NodeForge chỉ có tool retrieval nội bộ (`read_file`, `search_text`/`rg_search`, `search_code`, `select_code_graph_candidates`, `read_lines`...). SDK built-in `WebSearch`/`WebFetch` bị chặn cứng theo `docs/forge-mcp-tools-spec.md` ("dùng thuần tool MCP tự viết của Forge"). Vì vậy khi cần tài liệu ngoài repo (Next.js/Tailwind version, API docs, CVE, skill mẫu) agent phải nhờ human dán link thủ công.
- **Kết quả:** Agent có capability search web qua MCP Forge tool do Node thực thi. Node giữ API key, gọi provider, giới hạn số lượt/chi phí, trả kết quả đã chuẩn hóa và cắt ngắn; key không xuất hiện trong prompt hay tool result.
- **Giá trị:** Mở rộng retrieval ra ngoài repo mà vẫn giữ nguyên tắc "Node là Orchestrator + Verifier, Agent chỉ dùng controlled capabilities" (`ARCHITECTURE.md` §2, `docs/Nodeforge — Context Access & Agent Tool Architecture.md` §4/§8). Trả lời đúng thắc mắc đã trao đổi với người dùng: tìm Google bằng trình duyệt thì miễn phí, nhưng agent gọi Search API thì cần key và tốn tiền — chi phí phải nằm ở Node, có trần.

## 2. Phạm vi

### In scope

- Tool Forge mới `web_search` cho owner conversation (provider abstraction + adapter Google Custom Search và/hoặc Tavily/Brave/SerpAPI + mock adapter cho test).
- Tuỳ chọn phase 2: `web_fetch` đọc lại đúng URL đã trả về từ `web_search` (allowlist + giới hạn độ dài).
- Cấu hình qua env (pattern `loadConfig` ở `backend/src/bootstrap/config.js`, khai báo ở `config/env.example`): provider, key, quota/ngân sách, timeout, TTL cache.
- Đăng ký tool qua registry hiện hữu (`backend/src/tools/index.js#createForgeToolRegistry`, `backend/src/tools/owner-conversation-tools.js`), authorization qua `authorizeTool` (`backend/src/tools/tool-authorization.js`) và `ownerRoleTools` (`backend/src/tools/owner-role-tool-policy.js`).
- Logging `owner.tool_call` / `agent.activity` như các tool khác, summary đã redact.

### Out of scope

- Browser automation, crawl nhiều trang, chạy JS của trang web.
- Để agent tự giữ key, tự chọn endpoint, hoặc gọi provider ngoài Node.
- Bỏ `disallowedTools` / mở built-in `WebSearch`, `WebFetch`, `Bash` cho agent — guardrail hiện hành giữ nguyên.
- Sửa ticket/approval workflow, `.forge/` runtime state, hay nâng cấp Tailwind/Next.js/CSS system.
- UI hiển thị kết quả search (chỉ tool + dữ liệu; UI request riêng nếu cần).

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc bắt buộc:**
  - Key chỉ đọc từ env tại Node, không truyền xuống agent, không ghi vào log/payload; kết quả trả về là dữ liệu không tin cậy nên phải giới hạn độ dài và không được diễn giải như instruction (chống prompt injection).
  - Phải có quota chi phí thật: `max_calls_per_turn`, `max_calls_per_day`, timeout, cache TTL cho cùng query. Vượt ngưỡng trả `isError` với mã lỗi ổn định, theo quy tắc nhất quán của `docs/forge-mcp-tools-spec.md` (một ngôn ngữ thông báo, luôn `isError: true` khi lỗi).
  - Tool phải đi qua `authorizeTool` + capability list (`context.capabilities` được set từ `definitions` trong `owner-sdk-stream.js`), và chỉ xuất hiện cho role được phép; tool không có trong `definitions` thì model không nhìn thấy.
  - Output bounded theo Context Budget (`docs/Nodeforge — Context Access & Agent Tool Architecture.md` §7–§8): tool result vẫn tính token, không nhét full page.
  - File mới có summary comment đầu file/đầu function và giữ dưới 250 dòng theo `CLAUDE.md`.
  - Chưa có key thì tool vẫn tồn tại nhưng fail-closed (`WEB_SEARCH_UNCONFIGURED`); không được âm thầm trả kết quả rỗng vì agent sẽ kết luận sai.

- **Hướng đề xuất** (SL được điều chỉnh chi tiết trong guardrails):
  - `backend/src/infrastructure/web/`: `web-search-client.js` (fetch + timeout + retry/backoff + cache) và `web-search-providers.js` (adapter Google CSE / Tavily / Brave / mock).
  - `backend/src/tools/web-search-tool.js`: `createWebSearchTool(...)` + `webSearchDefinition` (input `{ query, num_results?, recency?, site? }`), trả `{ results: [{ title, url, snippet, source }] }`.
  - Registration: `backend/src/tools/index.js` (định nghĩa + implementation, có cờ bật/tắt) và `backend/src/tools/owner-conversation-tools.js` (thêm vào `implementations` + `definitions`).
  - Policy: `backend/src/tools/owner-role-tool-policy.js` thêm `web_search` (và `web_fetch` nếu làm) vào tool list của `system_engineer`; mặc định tắt với `architecture_manager` cho tới khi human duyệt.
  - Env mới: `NODEFORGE_WEB_SEARCH_PROVIDER`, `NODEFORGE_WEB_SEARCH_API_KEY`, `NODEFORGE_WEB_SEARCH_ENGINE_ID`, `NODEFORGE_WEB_SEARCH_MAX_CALLS_PER_DAY`, `NODEFORGE_WEB_SEARCH_TIMEOUT_MS`, cache TTL.
  - `backend/src/application/owner-sdk-stream.js`: `toolInstruction` hiện cấm web_search built-in, `fileToolInstruction` nêu `search_text`/`list_files`/`search_tree` là nguồn discovery — cần câu chữ phân biệt "tìm trong repo" vs "tìm tài liệu ngoài repo", nhắc kết quả web chỉ là tham khảo.
  - `codexOptions` (`webSearchMode: "disabled"`, `networkAccessEnabled: false`) giữ nguyên; Codex chỉ nhận MCP tool nếu human muốn bật sau.

- **Dependency thật sự:**
  - Human phải chốt provider + cấp key/ngân sách (quyết định chi phí, ngoài thẩm quyền SL/architecture).
  - Quyết định phase 1 chỉ `web_search` hay kèm `web_fetch` (allowlist/redirect/XSS là rủi ro riêng).
  - Config plumbing: adapter nhận service qua constructor (`createOwnerSdkStream`), nên cần lớp config/DI cho web search service trước khi tool chạy trong production wiring.

- **Quyết định chưa chốt:**
  - Google Custom Search JSON API (cần `API_KEY` + `ENGINE_ID`) hay Tavily/Brave/SerpAPI làm default.
  - Bật cho Coder/Reviewer trong ticket pipeline (`nodeforge-task-executors.js`, `review-worker.js`) hay chỉ owner conversation.
  - Persist kết quả search ở đâu (chỉ log, hay `conversationMessages`/SSE payload).

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `docs/forge-mcp-tools-spec.md` | Spec bộ tool Forge; nêu `WebSearch`/`WebFetch` thuộc `disallowedTools` | Đã đọc toàn văn, sha256:a0d3b2fa...9042 — cao |
| `docs/Nodeforge — Context Access & Agent Tool Architecture.md` | Nguyên tắc controlled capabilities + Context Budget cho retrieval | Đã đọc §1–§8, sha256:08a618e8...1395 — cao |
| `backend/src/tools/index.js` | `createForgeToolRegistry` + `dispatch` + `authorizeTool`, `wrap` tool | Đã đọc metadata + symbol map, sha256:f8c03a7e...1453 — cao |
| `backend/src/tools/owner-conversation-tools.js` | Ghép definitions/implementations cho owner SDK; set `context.capabilities`; log `owner.tool_call`/`agent.activity` | Đã đọc 80/108 dòng, sha256:7128b197...8cf1 — cao |
| `backend/src/tools/owner-role-tool-policy.js` | `ownerRoleTools` theo role + `authorizeOwnerTool` | Đã đọc 21–30/35 dòng, sha256:cc5782c8...1a3a — cao |
| `backend/src/bootstrap/config.js` | `loadConfig` đọc/validate env; nơi thêm cấu hình search | Đã đọc symbol `loadConfig`, sha256:6bd3be92...6034 — cao |
| `backend/src/application/owner-sdk-stream.js` | Route SDK theo profile, dựng `toolInstruction`/`fileToolInstruction`, `codexOptions.webSearchMode="disabled"` | Đã đọc 80/89 dòng, sha256:dbb83687...c192 — cao |
| `config/env.example` | Chỗ khai báo biến env mới (15 dòng) | Đã đọc, sha256:22596865...89d3 — cao |
| `backend/src/tools/tool-authorization.js` | Gate `capabilities` của tool | Đã đọc metadata, sha256:d4258de6...3c1c — trung bình (chưa đọc hết body) |

Candidate files định hướng discovery, không phải mutable-file allowlist cố định; SL xác minh đường thực tế trước khi chốt manifest.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Agent có capability search web qua tool Forge, không cần human dán link | Gọi `web_search` (mock provider) trả `results[]` có `title/url/snippet`; tool xuất hiện trong `definitions`/`capabilities` của role được phép; không có tool web nào khác. Unit test pass. | Provider + key đã chốt; đi qua `authorizeTool`/`authorizeOwnerTool` |
| O2 | Chi phí và lạm dụng bị chặn ở Node | Quota theo turn và theo ngày được enforce: vượt ngưỡng trả `isError` với mã lỗi ổn định; timeout cấu hình được; cùng query trong TTL trả cache và không gọi provider. Test chứng minh provider gọi đúng N lần. | O1; guardrail ngân sách |
| O3 | Không rò rỉ secret, không vượt Context Budget | Tool result và log (`owner.tool_call`, `agent.activity`) không chứa API key/engine id; số kết quả và độ dài snippet bị cắt theo cấu hình; phase 1 không trả full-page HTML. Test redact/size assertion. | O1; Context Budget §7–§8 |
| O4 | Nội dung web được đối xử là dữ liệu không tin cậy | Kết quả được sanitize (strip HTML/script); prompt nói rõ suy luận và sửa code vẫn phải dựa trên code thật trong repo, ưu tiên `search_text`/`search_code` cho repo và `web_search` cho tài liệu ngoài. | O1; guardrail injection |
| O5 | Fail-closed và tài liệu cập nhật | Thiếu key/provider thì message nêu đúng biến `NODEFORGE_WEB_SEARCH_*` cần set và agent vẫn làm được task không cần web; `docs/forge-mcp-tools-spec.md` có mục tool mới; `config/env.example` có biến mẫu không giá trị thật; `disallowedTools` vẫn chặn built-in web. | O1; giữ nhất quán ngôn ngữ lỗi |

**Gợi ý delivery (không bắt buộc):** O1+O5 (mock adapter, config, spec) trước, rồi O2 (quota/cache), rồi O3+O4 (redact, sanitize, prompt), cuối cùng wire provider thật; `web_fetch` tách phase riêng.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Chi phí API tăng âm thầm khi agent gọi nhiều vòng | Major | Fact: `config/env.example` chưa có env search nào nên chưa có budget; assumption: provider tính theo request | Human cấp ngân sách + quota cap ở O2; không bật production trước khi có cap |
| Prompt injection / nội dung web sai khiến agent sửa code theo | Major | Fact: agent đã giới hạn tool theo `owner-role-tool-policy.js`; assumption: kết quả web không đáng tin hơn repo | Guardrail O4; Reviewer đối chiếu khi code thay đổi |
| Rò rỉ key qua tool result hoặc log | Major | Fact: payload `owner.tool_call` gồm `input_keys` và `result: summarizeResult(result)`; chưa đọc hết `summarizeResult` | SL verify `summarizeResult` và redact theo allowlist field trước khi bật (O3) |
| Capability theo role bị vỡ khi thêm tool web | Major | Fact: `context.capabilities = definitions.map(name)` trong `owner-sdk-stream.js`; `authorizeTool` kiểm tra capabilities | Giữ nguồn capability là `definitions`; test phân quyền role (O1) |
| Built-in `WebSearch`/`WebFetch` bị mở lại | Blocker nếu xảy ra | Fact: `codexOptions` đang `webSearchMode:"disabled"`, `networkAccessEnabled:false`; spec yêu cầu `disallowedTools` | Kiến trúc giữ guardrail; chỉ thêm MCP tool của Node |
| Chọn provider nào (Google CSE vs Tavily/Brave/SerpAPI) | Major về chi phí/quality | Assumption: Google CSE cần `ENGINE_ID`; Tavily/Brave thiết kế cho agent | Human quyết; provider abstraction giúp đổi adapter mà không đổi contract |
| Có cho Coder/Reviewer dùng `web_search` trong ticket pipeline không | Major về scope | Fact: ticket pipeline dùng `createForgeToolRegistry`; chưa khảo sát `nodeforge-task-executors.js` | Chưa chốt — phase 1 giới hạn owner role |
| Cần `web_fetch` hay chỉ snippet là đủ | Minor | Assumption: snippet đủ cho đa số task Tailwind/Next.js | Chưa chốt — tách phase 2 |

## 7. Acceptance criteria của plan

- [ ] Mục tiêu, in/out scope và outcomes nhất quán với yêu cầu "làm tool search web cho agent".
- [ ] Facts repository-specific có evidence (file + sha256); assumptions/open questions ghi rõ, không khẳng định file chưa khảo sát.
- [ ] Guardrails (secret, quota, Context Budget, injection, giữ `disallowedTools`) tách khỏi gợi ý delivery.
- [ ] Mỗi outcome có tiêu chí quan sát được, đủ để SL tự lập SP.
- [ ] Không áp đặt số ticket, tên ticket hay mutable-file manifest; provider/key là quyết định human, đã ghi chưa chốt.
- [ ] SL chứng minh coverage và tuân thủ policy ticket hiện hành trước dispatch.
- [ ] Approval đúng identity/revision/SHA-256; lập SP không tự RUN/dispatch.

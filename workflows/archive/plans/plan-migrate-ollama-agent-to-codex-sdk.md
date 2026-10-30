<!-- Định hướng thay Ollama conversation adapter bằng Codex SDK cho các profile dùng model ChatGPT/OpenAI. -->
# Plan: Chuyển Ollama agent sang Codex SDK cho model ChatGPT

> **Trạng thái:** revision 1, đề xuất architecture; chưa được duyệt hay dispatch.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** `ollamaSdkGateway` hiện gọi `@anthropic-ai/claude-agent-sdk`, dù nhu cầu là chạy model do ChatGPT/OpenAI cung cấp. Contract endpoint của Ollama cũng đang mâu thuẫn: provider factory mô tả native `/api/chat`, còn gateway đặt `ANTHROPIC_BASE_URL` cho Claude SDK.
- **Kết quả:** Profile được chọn để dùng model ChatGPT/OpenAI chạy qua `@openai/codex-sdk` và `codexSdkGateway` hiện hữu, với conversation state dạng Codex thread, streaming/recovery/pause theo contract Codex hiện có.
- **Giá trị:** Một SDK và credential/base-URL contract nhất quán với nhà cung cấp model; loại bỏ dependency Claude SDK khỏi đường chạy của agent đã chuyển.

## 2. Phạm vi

### In scope

- Chuyển các **profile được human chọn** từ `provider: "ollama"` sang `provider: "codex"`, giữ nguyên agent ID, role, enabled/status và secret reference khi credential đó hợp lệ cho Codex/OpenAI.
- Dùng `codexSdkGateway` làm adapter duy nhất cho các profile đã chuyển, bao gồm Test Connection và owner conversation Architecture/System.
- Chuẩn hóa `gateway_url` theo contract Codex hiện có (HTTPS base URL, gateway normalizes về `/v1`); model là model identifier được gateway ChatGPT/OpenAI hỗ trợ.
- Bảo toàn server-side secret handling, role/tool policy, durable checkpoint, Continue/Restart/Discard, error sanitization và authorization hiện có.
- Xác minh runtime behavior: route owner conversation tới Codex, Codex thread persistence/Continue, Esc/pause abort, Test Connection, và failure contract.
- Quyết định lifecycle của Ollama-specific agent gateway/provider/tests sau khi không còn profile nào dùng nó: remove theo migration hoàn tất, hoặc giữ tạm như legacy path có deprecation boundary rõ ràng.

### Out of scope

- Không viết adapter để Codex SDK gọi native Ollama `/api/chat`; đây là hai provider contracts khác nhau.
- Không đổi Ollama embedding/retrieval provider (`ollama-embedding-provider`) hay cấu hình `OLLAMA_*` phục vụ index.
- Không tự suy ra rằng ChatGPT consumer subscription là API/Codex SDK credential hợp lệ; không đưa credential vào UI, logs, SSE hay source.
- Không đổi public recovery API, conversation IDs, `.forge/` ownership, role permissions, hay mở rộng scope sang refactor toàn bộ provider routing.

## 3. Hướng tiếp cận và guardrails

- **Hướng đề xuất:** migration cấu hình-first. Profile cần dùng model ChatGPT được đổi sang `provider: "codex"`; composition root đã tạo `codexSdkGateway` và map owner SDK hiện đã có entry `codex`. Không đổi `ollamaSdkGateway` thành một wrapper Codex với nhãn provider sai.
- **Credential/authentication:** Codex gateway hiện resolve `credential_ref`, truyền `apiKey` và normalized `gateway_url` vào `@openai/codex-sdk`. Human phải xác nhận loại credential và endpoint được ChatGPT/OpenAI/gateway cấp cho Codex SDK; nếu entitlement không hỗ trợ API/Codex SDK, migration bị block thay vì thử dùng session/cookie ChatGPT.
- **Compatibility:** `conversationStateStore` chỉ retain provider state khi `sdk_provider` trùng profile provider. Đổi `ollama` sang `codex` phải có behavior xác định: conversation/history cũ được dùng làm bounded prompt context cho turn mới; không attempt Continue trên Ollama execution bằng Codex. Interrupted Ollama record chỉ Restart hoặc Discard, trừ khi server reconciliation chứng minh provider session compatible (mặc định không compatible).
- **Rollback:** giữ profile/database data có thể rollback trong giai đoạn rollout, nhưng rollback chỉ cho turn mới. Không tái sử dụng Codex thread ID như Ollama session, và ngược lại. Rollback owner: SL xác định backup/audit mechanism theo storage contract hiện hành.
- **Rollout:** thử Test Connection server-side với một profile non-production/explicitly selected, sau đó one-owner conversation smoke test trước khi chuyển các profile còn lại. Không xóa Ollama code/credential data trước khi exit criteria và rollback window do human chốt.
- **Observability:** `owner.sdk_route`/`owner.sdk_request_started` phải cho thấy `provider: codex`, `conversation_mode: thread` và không log API key, URL query secret, prompt hoặc raw provider response.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `backend/src/modules/agent/codex-sdk-gateway.js` | Existing `@openai/codex-sdk` adapter; accepts profile credential/base URL, thread resume and `abortSignal` | Read SHA `aae53b…29ee` |
| `backend/src/application/agent-settings-service.js` | Provider-specific Test Connection; `codex` already executes Codex gateway, `ollama` executes separate gateway | Read SHA `ae74f…558b` |
| `backend/scripts/control-api-agent.mjs` | Creates Codex and Ollama gateways; bootstrap Architecture profile defaults toward Codex | Read SHA `075b25…a12d` |
| `backend/scripts/start-control-api.mjs` | Owner `sdkGateways` map contains Codex but not Ollama | Read SHA `7dd640…a853` |
| `backend/src/application/owner-sdk-stream.js` | Selects by `profile.provider`; Codex uses `thread` mode and forwards cancellation | Read SHA `8a933a…163f` |
| `backend/src/modules/agent/{ollama-sdk-gateway,ollama-sdk-provider}.js` | Current Ollama path imports Claude SDK; URL contract/comment disagreement must not be carried into Codex migration | Read SHA `9d1d3b…962b`, `333daa…4f94` |
| `backend/tests/unit/{codex-sdk-gateway,ollama-sdk-gateway}.test.js` | Codex has mocked behavior coverage including abort; Ollama tests assert Claude SDK env only | Read SHA `ffee23…ca93`; search/read evidence for Ollama |

Candidate paths guide SL discovery only; they are not a mutable-file allowlist.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Configured target agent uses Codex | Selected profile persists `provider: "codex"`, valid Codex endpoint/model/credential reference, and server-side Test Connection invokes only Codex gateway. No secret appears in returned profile/error/event. | Human confirms credential entitlement and target profiles |
| O2 | Owner conversation has consistent Codex semantics | Architecture/System target conversation routes to `codexSdkGateway`, emits/retains a Codex `thread_id`, streams response, and an Esc/pause abort reaches the Codex SDK signal. | Existing owner tool and authorization policies unchanged |
| O3 | Provider transition is recovery-safe | A pre-migration Ollama execution cannot Continue through Codex; UI/server yields existing session-unavailable/reconcile-safe behavior and permits only safe Restart/Discard as applicable. New Codex interruptions Continue using their own thread/checkpoint. | Durable checkpoint remains authority |
| O4 | Migration is operable and reversible | Rollout/rollback instructions identify profile data, validation gates, no-cross-provider session rule and legacy Ollama removal/deprecation decision. Tests cover profile routing, Test Connection, owner stream and pause/recovery behavior. | Human chooses removal timing |

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| ChatGPT account credential may not authorize Codex SDK/API endpoint | Blocker | Existing Codex gateway expects API key plus endpoint; repository evidence cannot establish account entitlement | Human supplies/validates supported credential and endpoint before delivery |
| Which Ollama profiles are intended to migrate? | Major | Repository supports multiple roles/providers, while request names “ollama agent” generically | Human names profile IDs/roles and production rollout order |
| Continue crosses incompatible provider session | Major | Owner state keys provider; Codex is thread mode, Ollama is history mode | Enforce O3; no provider-session translation |
| Deleting Ollama path could break Supervisor greeting or settings test for remaining profiles | Major | Supervisor receives `ollamaSdkGateway`; settings has dedicated branch | Inventory consumers and migrate/remove only after no supported profile depends on it |
| Native Ollama comments/tests remain misleading if legacy code remains | Minor | Provider says `/api/chat`; gateway uses Claude SDK base URL | Correct/deprecate contract as part of chosen legacy lifecycle |

## 7. Acceptance criteria của plan

- [ ] Plan distinguishes a profile/provider migration from a fake “Codex over Ollama” adapter.
- [ ] Credential entitlement, target profiles and legacy-Ollama lifecycle are explicit human decisions.
- [ ] Outcomes protect provider-session boundaries, secret handling, recovery and authorization.
- [ ] SL may split implementation and verification work but must preserve O1–O4.
- [ ] Human approval must identify this revision and its exact SHA-256; approval does not dispatch implementation.

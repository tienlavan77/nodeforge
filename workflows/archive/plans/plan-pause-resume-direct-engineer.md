# Plan: Durable pause/resume cho direct system_engineer (Esc x2)

<!-- Tạm dừng/tiếp tục có chủ ý cho lượt system_engineer trực tiếp bằng execution checkpoint bền vững. -->

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** `owner-sdk-stream` chỉ chặn trùng lượt bằng `activeConversations` in-memory và chỉ ghi `sdk_thread_id` + `sdk_history` sau khi lượt hoàn tất. Nếu process chết giữa chừng, timeout, hoặc owner muốn tạm dừng, trạng thái của lượt đang chạy (tool đã xong, file đã đổi, commit đã tạo, provider thread) bị mất. Nối lại chỉ bằng chat history sẽ replay mù, có thể ghi đè file hoặc push trùng.
- **Kết quả:** Lượt direct `system_engineer` chạy trong một resumable execution lifecycle: checkpoint bền vững ở các tool boundary, provider session được lưu sớm, lease/heartbeat phát hiện `interrupted`, và owner Esc x2 để tạm dừng có chủ ý rồi chọn Continue / Restart / Discard an toàn.
- **Giá trị:** Tận dụng đúng hướng của `agent-execution-checkpoint.js` và `ticket-resume` nhưng tách contract riêng cho owner conversation (project-wide, có commit/push, prompt mới có thể khác), thay vì bê nguyên ticket checkpoint vào.

## 2. Phạm vi

### In scope

- Tách ba lớp trạng thái cho direct owner flow: Chat state / Execution checkpoint / Workspace state.
- Ghi execution checkpoint quanh mỗi Forge tool call của direct `system_engineer` và tại các mốc: bắt đầu execution, `session_ready`, sau thay đổi file, sau commit/push, kết thúc/lỗi/timeout.
- Phân loại replay: retryable / cần reconcile / không tự động replay, dựa trên checksum, HEAD, commit receipt.
- Lưu provider thread/session ngay khi có `onSessionReady`; fallback sang structured resume prompt dựng từ checkpoint có giới hạn.
- Lease/heartbeat cho execution đang chạy; mất heartbeat chuyển `running` thành `interrupted`.
- UX Esc x2: Esc lần 1 hiện hint, Esc lần 2 trong cửa sổ ngắn gửi abort có kiểm soát; UI hiển thị execution bị gián đoạn với Continue / Restart / Discard.
- Endpoint query/resume/discard execution dở cho conversation.

### Out of scope

- Tăng timeout vô hạn hoặc checkpoint từng token streaming.
- Tự động resume sửa code ngay khi Node restart mà owner chưa chọn.
- Thay đổi semantics ticket/supervisor checkpoint hiện có; chỉ mượn khái niệm.
- Mở rộng cơ chế này cho `architecture_manager` ngoài phạm vi read-only hiện tại.
- Sửa `.forge/` layout do Node quản lý.

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc bắt buộc:**
  - Checkpoint nằm dưới `.forge/runtime` do Node sở hữu; watcher ignore vùng này; agent không tự ghi.
  - Không replay mù side effect: `write_diff`/`edit_diff`/`run_check` phải reconcile filesystem/checksum trước; `commit_changes`/`push_commit` phải kiểm tra HEAD, commit SHA đã tồn tại, trạng thái push trước khi chạy lại.
  - Lỗi checksum khi resume được diễn giải là "thao tác có thể đã hoàn tất hoặc workspace đã đổi", không phải tín hiệu retry ngay.
  - `conversation-state-store` vẫn là chat state; execution checkpoint là source of truth cho việc tiếp tục. Không phụ thuộc hoàn toàn vào provider thread vì Node mới là nơi chạy Forge tool và biết workspace thực tế.
  - Không xóa checkpoint cũ khi tạo attempt mới; ghi `attempt`/`resume_of` để audit chuỗi retry.
  - `activeConversations` giữ vai trò guard trong process, nhưng phải có lease bền vững để restart không cho hai instance cùng resume một conversation.

- **Hướng đề xuất:**
  - Bọc `registry` tool trả về từ `createOwnerConversationTools` bằng một resumable executor: ghi `step_started` (tool_name, tool_call_id, normalized_input_hash, sequence) trước khi chạy, `step_completed` (bounded_result_summary, changed_paths, next_sequence) sau khi thành công.
  - Tạo store checkpoint riêng cho owner conversation, key theo `conversation_id` + `execution_id` (`correlation_id` hiện đang được dùng làm `execution_id` trong `owner-sdk-stream`), trường tối thiểu: `status`, `provider`, `provider_thread_id`, `user_prompt_hash`, `last_completed_step`, `completed_tool_calls`, `changed_paths`, `next_action_hint`, lease fields.
  - `stream()` nhận `abortSignal`; abort/timeout/process death giữ checkpoint ở `interrupted`/`resumable`; chỉ chuyển `completed` sau khi final response và state đã ghi bền vững.
  - Persist `provider_thread_id` ngay trong callback `onSessionReady` thay vì chỉ ở `conversationStateStore.update` sau khi xong.
  - Resume ứng viên: cùng `conversation_id` và `user_prompt_hash` trùng execution `interrupted` thì gợi ý Continue; prompt khác thì yêu cầu owner chọn, không tự đoán.

- **Dependency thật sự:**
  - Chốt semantics Continue / Restart / Discard trước khi thiết kế API và UI.
  - Chốt bảng phân loại tool retry/reconcile/no-auto-replay trước khi viết wrapper.
  - Chốt runtime storage path + retention + TTL heartbeat cho owner checkpoint trước khi triển khai.

- **Quyết định chưa chốt:**
  - Có cho phép auto-Continue khi owner gửi lại đúng cùng prompt, hay luôn cần một cú xác nhận? Ảnh hưởng O2.
  - Ngưỡng heartbeat/lease và retention (giữ bao nhiêu execution mỗi conversation)? Ảnh hưởng O1/O4.
  - Provider nào ưu tiên resume thread, provider nào luôn dùng structured resume prompt? Ảnh hưởng O3.
  - Esc x2 nên abort cứng (hủy tool đang chạy) hay soft pause (chặn tool boundary kế tiếp)? Ảnh hưởng O2 và độ phức tạp implement.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `backend/src/application/owner-sdk-stream.js` | Nơi bọc resumable executor, persist session sớm, nhận abortSignal | Đã đọc source (89 dòng): `activeConversations = new Set()` ở dòng 11, `onSessionReady` chỉ gán biến `threadId` cục bộ, `conversationStateStore.update` chỉ chạy ở dòng 67 sau khi `finalResult?.text` — chắc chắn |
| `backend/src/modules/protocol/conversation-state-store.js` | Chat state hiện tại, không có execution status | Đã đọc symbol map: `create/get/update/clear/advanceRound/markStatus/archive`, không có trường checkpoint — chắc chắn |
| `backend/src/modules/agent/agent-execution-checkpoint.js` | Pattern checkpoint đang dùng `.forge/runtime/agent-checkpoints`, atomicWrite + `listPending` | Đã đọc source: key theo `task_id`, status loại `completed`/`blocked`; không có lease/heartbeat — chắc chắn |
| `backend/src/tools/owner-conversation-tools.js` | Registry tool cần bọc; đã ghi `owner_changed_paths` quanh `write_diff`/`edit_diff` | Search kết quả dòng 62-64 — chắc chắn |
| `backend/src/tools/owner-engineer-tools.js` | `commit_changes`/`push_commit` đã lưu `owner_last_commit_sha`, nền tảng cho receipt | Search kết quả dòng 40-53 — chắc chắn |
| `backend/scripts/control-api-http.mjs` + `start-control-api.mjs` | Wiring `sdkStream`, cần thêm abort/resume route | Mới thấy chỗ khởi tạo, chưa khảo sát route — giả định, SL phải verify đường đi thực tế |
| `ui/nextjs/components/home-chat-composer.jsx` | Composer chỉ xử lý Enter/ArrowUp/ArrowDown, chưa có Esc | Đã đọc source dòng 77-85 — chắc chắn |
| `ui/nextjs/lib/home-page-message-handlers.js`, `ui/nextjs/lib/node-forge-send-message.js` | Handler gửi message, nơi gắn abort/resume | Đã đọc; `sendingRef` in-memory, không có cancel — chắc chắn |
| `ui/nextjs/lib/node-client.js` | Cần thêm client method resume/discard (đã có `resumeCode` cho ticket) | Search thấy `resumeCode` dòng 182 — giả định tái sử dụng pattern |
| `backend/src/application/ticket-resume` flow | Ý tưởng resume có chủ ý, không phải contract của owner flow | Chưa khảo sát chi tiết file — assumption, không được dùng làm fact |

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Direct `system_engineer` có execution checkpoint bền vững, tool-aware | Một lượt tạo `execution_id` riêng; checkpoint được ghi tại start, `session_ready`, trước/sau mỗi Forge tool, sau file change, sau commit/push, và khi kết thúc/lỗi/timeout; restart Node vẫn đọc được record `interrupted` từ `.forge/runtime`; record chỉ chứa bounded summary + hash + `changed_paths`, không chứa nội dung file hay full tool output | Chốt storage/retention; không phụ thuộc provider thread |
| O2 | Owner tạm dừng bằng Esc x2 và chọn hướng tiếp tục có chủ ý | Đang chạy: Esc lần 1 hiện hint, Esc lần 2 gửi abort; backend giữ checkpoint ở `interrupted` (không xóa); UI hiển thị execution dở với Continue / Restart / Discard; Continue reconcile checksum/HEAD/commit receipt trước khi chạy tiếp; Restart tạo attempt mới có `resume_of`; Discard đóng execution nhưng vẫn còn audit record | Phụ thuộc O1 + chốt semantics; không auto-resume khi restart |
| O3 | Provider session được lưu sớm và có fallback không phụ thuộc provider | `provider_thread_id` bền vững ngay sau `onSessionReady`; nếu provider hỗ trợ thread thì resume đúng thread; nếu thread mất hoặc provider chỉ history mode, Node dựng structured resume prompt từ checkpoint, có giới hạn độ dài, nêu rõ "đã hoàn tất / không lặp lại nếu checksum cho thấy đã tồn tại / bước tiếp theo" | Phụ thuộc O1; guardrail không nhét transcript đầy đủ |
| O4 | Lease/heartbeat phân biệt đang chạy với đã chết | Mỗi execution đang chạy có `owner_instance_id`, `lease_started_at`, `heartbeat_at`; timeout chỉ làm lease hết hạn và chuyển `interrupted`, không mất record; hai instance không cùng resume một `conversation_id`; `activeConversations` vẫn chặn trùng trong process | Phụ thuộc O1; chốt ngưỡng heartbeat |
| O5 | Replay an toàn theo phân loại tool | Bảng phân loại được hiện thực hóa: retryable (search/read/git status-diff), reconcile trước khi retry (`write_diff`/`edit_diff`/`run_check`), không auto-replay (`commit_changes`/`push_commit`); resume dùng receipt (commit SHA, kết quả push) để không tạo commit/push lần nữa; precondition checksum hiện tại vẫn được giữ | Chốt phân loại tool; guardrail không xóa checkpoint khi retry |

**Gợi ý delivery (không bắt buộc):** có thể chạy song song (a) backend checkpoint + session/lease + phân loại tool cho O1/O3/O4/O5, và (b) control API abort + UI Esc x2 và panel Continue/Restart/Discard cho O2; tích hợp bằng một ca e2e gián đoạn giữa lượt có `edit_diff` + `commit_changes` để chứng minh không replay mù.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Bê nguyên ticket checkpoint vào owner conversation | Major | Ticket có candidate scope cố định; owner flow project-wide + commit/push + prompt đổi giữa lần resume — facts từ `owner-sdk-stream` | Architecture + human: chốt contract riêng, plan này đã tách |
| Process chết sau side effect nhưng trước khi ghi `step_completed` | Blocker | Suy luận từ mô hình checkpoint current-vs-completed; chưa kiểm chứng window thực tế | Architecture guardrail: reconcile bắt buộc, O5; SL phải verify bằng test |
| Lease giả: tiến trình cũ còn sống nhưng heartbeat dừng | Major | `activeConversations` in-memory, sau restart không còn record — facts | Chốt TTL + rule "chỉ resume khi lease hết hạn"; O4 |
| Provider thread mất hiệu lực hoặc khác provider | Major | `owner-sdk-stream` đã có nhánh `sameProvider` reset state — facts | Chốt fallback structured prompt, O3 |
| Esc x2 bắt cả khi IME đang composition | Minor | `home-chat-composer` đã dùng `composingRef` cho Enter — facts | SL tự quyết trong guardrails: ignore khi composing, cửa sổ thời gian cho phím kép |
| Checkpoint phình hoặc ghi quá nhiều | Minor | Guardrail chỉ lưu bounded summary | Architecture giữ O1 criteria; SL chọn boundary |
| Abort giữa tool đang ghi file để lại workspace hỏng một nửa | Major | `write_diff`/`edit_diff` đi qua File Service atomicWrite nên một file không dở — facts từ pattern atomicWrite trong checkpoint store; nhiều file trong một tool call thì chưa chắc | Human/architecture: chấp nhận reconcile bằng checksum thay vì rollback, hoặc yêu cầu rollback — ảnh hưởng O2/O5 |
| Retention và audit: giữ bao nhiêu execution, ai dọn | Minor | Chưa có policy cho `.forge/runtime` owner checkpoint — assumption | Human chốt retention trước khi SL lập ticket storage |

## 7. Acceptance criteria của plan

- [ ] Mục tiêu, in/out scope và outcomes nhất quán với chẩn đoán hiện trạng và yêu cầu Esc x2.
- [ ] Facts repository-specific có evidence từ source đã đọc; assumptions và mục chưa khảo sát ghi rõ, không biến discovery gap thành fact.
- [ ] Guardrails (không replay mù, `.forge/` thuộc Node, không auto-resume) tách khỏi gợi ý delivery.
- [ ] Mỗi outcome có tiêu chí quan sát được và đủ để SL chủ động lập SP.
- [ ] Không khóa số ticket, tên ticket hay mutable-file manifest; các quyết định cần human chốt đã nêu ở mục 3 và 6.
- [ ] SL phải chứng minh coverage từng O và tuân thủ policy ticket hiện hành trước dispatch.
- [ ] Approval đúng identity/revision/SHA-256 của plan này trước khi lập SP; plan không tự RUN/dispatch.

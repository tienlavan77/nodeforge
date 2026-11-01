<!--
Mục đích nghiệp vụ: Báo cáo bàn giao kết quả triển khai kỹ thuật của System Engineer (SE) cho Project Owner và Architecture Manager (AM) đối với đặc tả Unified JSON-First Planning (Chat / .md), Phản biện AM ↔ SE & Auto-Handoff (SL / SE).
Mô tả kỹ thuật: Tổng hợp chi tiết các file tạo mới/cập nhật, số lượng code_lines (<= 250), mã băm sha256, hợp đồng kỹ thuật của từng thành phần, kết quả kiểm thử đơn vị/tích hợp/UI stream và kiểm tra tĩnh ESLint.
-->
# Báo cáo Bàn giao SE: Unified JSON-First Planning (Chat / `.md`), Phản biện `AM ↔ SE` & Auto-Handoff (`SL` / `SE`)

- **Người nhận (Intended Recipient):** Project Owner & Architecture Manager (AM)
- **Người thực hiện:** System Engineer (SE)
- **Ngày báo cáo:** 2026-10-30
- **Tài liệu thiết kế tham chiếu:**
  - `docs/architecture/unified-json-plan-and-auto-handoff.md` (`sha256:71edb97fa82e69a298b635abcc75344c25a16551578e550f01c2531097f10369`)
- **Trạng thái tổng thể:** **HOÀN TẤT (`PASS`)**

---

## 1. Tổng quan Kiến trúc & Luồng Nghiệp vụ Đã Hoàn Thiện

1. **Lập kế hoạch JSON-First hợp nhất từ Hội thoại hoặc File `.md` (`source_kind: "conversation" | "markdown_file"`):**
   - Cho phép Owner tạo kế hoạch kiến trúc trực tiếp từ cuộc hội thoại hoặc chỉ định một file `.md` trong dự án (ví dụ: `tạo kế hoạch từ docs/spec.md, giao việc cho SL` hoặc `tạo kế hoạch từ docs/spec.md, giao việc cho SE`).
   - Lưu đầy đủ dấu vết nguồn (`source_kind`, `source_file_path`, `source_file_sha256`, `delivery_target`) vào `conversation-intake.json` và giữ nguyên qua cả phiên tạm dừng hỏi đáp (`awaiting_owner_decisions` $\rightarrow$ `/plan-continue`).
2. **Giai đoạn 1 — Phản biện & Thống nhất kế hoạch `AM ↔ SE` (1–2 vòng cho mọi nhánh giao việc `SL` và `SE`):**
   - **AM (người viết kế hoạch)** trình bày kế hoạch bằng ngôn ngữ tự nhiên (`formatHumanReadableHandoffBrief`) trên cả 2 khung chat (`Architecture` và `System`), tuyệt đối không xả khối raw JSON lên giao diện, và mời **SE (người phản biện kế hoạch)** khảo sát codebase để phản biện kỹ thuật.
   - **SE** khảo sát và phản hồi kèm nhãn `[CRITIQUE: ALIGNED]` (đồng thuận) hoặc `[CRITIQUE: DISCUSS]` (đề xuất làm rõ/điều chỉnh).
   - Nếu SE trả về `[CRITIQUE: DISCUSS]` ở vòng 1, AM giải đáp bằng ngôn ngữ tự nhiên trên cả 2 khung chat và có thể cập nhật kế hoạch sang `r2` (qua RFC 7396 JSON Merge Patch) trước khi SE xác nhận lần cuối ở vòng 2.
   - Sau khi thống nhất, hệ thống tự động duyệt (`markdownPlanStore.decide`) revision mới nhất và đăng thông báo chốt thống nhất lên cả 2 khung chat.
3. **Giai đoạn 2 — Tự động chuyển giao thực thi theo đích (`delivery_target`):**
   - **Nhánh `delivery_target === "sl"` (`phase: "sl_handoff"`):** Tự động gọi `approvePlan` / `handoffApprovedPlan` để **Sprint Leader (SL)** sinh **Sprint Plan JSON** và danh sách **Tickets** ở trạng thái `ready`.
   - **Nhánh `delivery_target === "se"` (`phase: "implementation"`):** Chuyển sang vòng lặp **SE** trực tiếp viết mã & chạy kiểm thử, **AM** nghiệm thu đối chiếu từng `outcomes[].acceptance_criteria` (`[VERDICT: PASS]` / `[VERDICT: REVISE]`, tối đa 5 vòng).
4. **Cơ chế Dual-Stream tách biệt phần trao đổi hội thoại và phần gọi tool `RAN`:**
   - **Trên kênh chính của SE (`/system`, `payload.conversation_id === activeConversationId`):** Giữ nguyên 100% hành vi hiện có — stream đầy đủ cả lời nói (`text`) lẫn các bước chạy lệnh/tool (`command_execution` / khối `RAN`).
   - **Trên kênh liên kết phía AM (`/architecture`, `payload.linked_conversation_id === activeConversationId`):** Chỉ dual-stream phần trao đổi hội thoại (`entry.type === "text"`), ẩn hoàn toàn các sự kiện/mục `command_execution` (và không tạo bong bóng chat rỗng khi lượt đang chạy mới chỉ có lời gọi tool).

---

## 2. Chi tiết các Thay đổi Mã nguồn & Bài Kiểm thử

| Hạng mục | Đường dẫn file | Thao tác | `code_lines` (`<= 250`) | Checksum (`sha256`) | Nội dung kỹ thuật đã thực hiện |
| :---: | :--- | :---: | :---: | :--- | :--- |
| **Mục 2** | `backend/src/modules/governance/conversation-plan-trigger.js` | Cập nhật | `97` | `sha256:703d64a08bd135aa5225d754ab4fad3392eb1c1b30d81770db43b3d1df65041e` | Bổ sung `parseConversationPlanCreateTrigger(text)` và `normalizeDeliveryTarget(raw)` khớp đầy đủ tổ hợp `(conversation \| markdown_file) × (none \| sl \| se)` bằng tiếng Việt & tiếng Anh; giữ nguyên state machine loại trừ câu hỏi, trích dẫn, code fence và chống trộn lệnh duyệt (`PLAN_APPROVAL_MIXED`). |
| **Mục 3** | `backend/src/application/conversation-planning-service.js` | Cập nhật | `162` | `sha256:ab914bfe478f120f93742c343de134e031455810a393292a385276f179f1fe9c` | Kiểm tra an toàn đường dẫn `.md` (`PLAN_SOURCE_PATH_INVALID`), đọc nội dung file (`PLAN_SOURCE_MISSING`), tính `source_file_sha256`, lưu vào `conversation-intake.json` và giữ `delivery_target` xuyên suốt phiên hỏi đáp làm rõ. |
| **Mục 4** | `backend/src/application/am-se-handoff-store.js` | **Tạo mới** | `98` | `sha256:466f5a2afc2674c43c36df78595c65d553aa52d9b4e204ece29157e0b276b8a1` | Lưu trữ bền vững trạng thái phiên phản biện & handoff tại `.forge/runtime/nf/se-handoffs/<projectId>/<handoffId>.json` với `phase` (`plan_critique`, `sl_handoff`, `implementation`), `status` (`critiquing`, `running`, `reviewing`, `completed`, `paused`, `failed`), `critique_round`, `round`, và `history`. |
| **Mục 4** | `backend/src/application/am-se-handoff-service.js` | **Tạo mới** | `229` | `sha256:5f5a821bbda30bd357adfa7c4d6cd6e2f7bb78de2afa9d690f463062eb666a8f` | Triển khai `formatHumanReadableHandoffBrief`, `parseSePlanCritique`, `parseAmReviewVerdict`, `maybeApplyCritiqueRevision`, và `startHandoff` điều phối Giai đoạn 1 (`plan_critique` 1–2 vòng giữa `AM ↔ SE`) và Giai đoạn 2 (`sl_handoff` cho SL hoặc `implementation` 1–5 vòng cho SE). |
| **Mục 4** | `backend/src/application/owner-chat-command-service.js` | Cập nhật | `152` | `sha256:9b04a0100db80933b3e9f6c7c4701639159daeb132cfe5af8d773e171d0ff337` | Tích hợp `applyAutoHandoffIfRequested` cho cả `/plan` khởi tạo mới và `/plan-continue` để chuyển cả 2 nhánh `sl` và `se` qua `amSeHandoffService.startHandoff`. |
| **Mục 4** | `backend/src/application/owner-chat-service.js` | Cập nhật | `83` | `sha256:94c7360bf3c90cb22aa75ebeccaaa147509962e3bcb497f548c4415a8b4ed285` | Truyền `requestSystemEngineer` vào `commandService.execute` để kích hoạt lượt phản biện và thực thi của SE. |
| **Mục 4** | `backend/scripts/control-api-http.mjs` | Cập nhật | `167` | `sha256:912a789f25cecf40763d54c39faf95254c4968867af5947747988b1f9e7458d6` | Kết nối `bus`, `conversationCrudService`, `agentRoleResolver`, và `requestSystemEngineer` vào `createOwnerChatCommandService` và `createOwnerChatService`. |
| **Mục 5** | `backend/src/application/system-engineer-sdk-events.js` | Cập nhật | `40` | `sha256:bbd2bb319a251763d1db914b9d88e154c436f9aa4edbdafeffcd964bcb869946` | Đính kèm `linked_conversation_id` vào payload của sự kiện `agent.activity` và bản ghi audit. |
| **Mục 5** | `backend/src/application/owner-sdk-stream.js` | Cập nhật | `134` | `sha256:a56cee393bad985ea650ba8a5192801e23696246b5d7af8533a29c538e339bd6` | Truyền `linkedConversationId` vào `withSystemEngineerEvents` khi SE chạy trong phiên liên kết với AM. |
| **Mục 5** | `backend/src/application/conversation-audit-history-service.js` | Cập nhật | `107` | `sha256:32ab4a8b62c44abe9afdd43fa38278f8c8594bf2a8e3b18e50518d1c1404f3a2` | Bổ sung `projectLinkedRecord`: giữ nguyên đầy đủ lịch sử trên kênh chính, và lọc chỉ giữ phần lời nói (`entry.type === "text"`) khi truy vấn qua `linked_conversation_id`. |
| **Mục 5** | `ui/nextjs/lib/system-engineer-conversation-events.js` | Cập nhật | `54` | `sha256:6b318bd6d52a21b5ca8cb4b713d949ab12322a01102919b9686966aec0d3c183` | Giữ nguyên stream `text` + `command_execution` (`RAN`) trên kênh chính của SE; trên kênh liên kết (`linked_conversation_id === activeConversationId`), lọc bỏ `command_execution` và chỉ giữ `entry.type === "text"`. |
| **Mục 5** | `ui/nextjs/lib/use-conversation-message-history.js` | Cập nhật | `126` | `sha256:bc186218516333b5d37b30d6f166ed4345353c54af3dab8f49b78559a74a0c16` | Truyền `conversationRef.current` vào `systemEngineerConversationEvent` khi khôi phục lịch sử hội thoại. |
| **Mục 5** | `ui/nextjs/lib/home-page-event-stream.js` | Cập nhật | `115` | `sha256:2bd46ff1a58bc62ec3c3af8d5d3668cb6dcbffb3104f9a24beb45919745755a7` | Mở rộng bộ lọc SSE nhận diện sự kiện có `payload.linked_conversation_id === activeConversationIdRef.current`. |
| **Mục 5** | `ui/nextjs/components/architecture-workspace.jsx` | Cập nhật | `137` | `sha256:bae112d607d8cfec718f4b99aadc71ae8a6b660d2ec2582f76cc09fcfb6725dc` | Render `<SystemEngineerReply />` khi `message.se_event?.type === "conversation_turn"` để hiển thị lời nói trao đổi của SE ngay trên khung chat Architecture. |
| **Mục 6** | `backend/tests/unit/conversation-plan-create.test.js` | Cập nhật | `144` | `sha256:5de2a9677cdd092066db0a590521670fb58851861f785497f339e7689c211840` | Kiểm thử đơn vị cho bộ phân tích câu lệnh `(conversation \| markdown_file) × (none \| sl \| se)` bằng tiếng Việt và tiếng Anh. |
| **Mục 6** | `backend/tests/unit/conversation-plan-handoff.test.js` | Cập nhật | `221` | `sha256:54432e64b7ae9388c7edfe8564c53e50ea8ec3f7d396d6e790265a07386f102a` | Kiểm thử tích hợp cho lập kế hoạch từ file `.md`, phản biện `AM ↔ SE` (`ALIGNED` 1 vòng và `DISCUSS` $\rightarrow$ `ALIGNED` 2 vòng), bàn giao tự động sang `SL` (`ready`) và `SE` (`REVISE` $\rightarrow$ `PASS`). |
| **Mục 6** | `ui/nextjs/tests/system-engineer-conversation-stream.test.js` | Cập nhật | `240` | `sha256:08294a799ecc58f032dd0b0c9f1c38a73323fcd9df1a6be971f7bb0a38cfda8c` | Kiểm thử luồng SSE Dual-Stream: kênh chính SE hiển thị cả `text` và `RAN`, kênh liên kết Architecture chỉ hiển thị `text` và ẩn hoàn toàn `RAN`. |

---

## 3. Bằng chứng Kiểm thử & Xác minh

1. **Bộ kiểm thử Unit, Integration & UI Stream (`PASS`, `exit_code: 0`):**
   ```sh
   node --test \
     backend/tests/unit/conversation-plan-create.test.js \
     backend/tests/unit/conversation-plan-handoff.test.js \
     backend/tests/unit/conversation-plan-recovery.test.js \
     ui/nextjs/tests/system-engineer-conversation-stream.test.js
   ```
2. **Kiểm tra tĩnh ESLint & Quy chuẩn `code_lines <= 250` (`PASS`, `exit_code: 0`):**
   ```sh
   pnpm exec eslint --rulesdir eslint-rules \
     backend/src/modules/governance/conversation-plan-trigger.js \
     backend/src/application/am-se-handoff-store.js \
     backend/src/application/am-se-handoff-service.js \
     backend/src/application/conversation-planning-service.js \
     backend/src/application/owner-chat-command-service.js \
     backend/src/application/owner-chat-service.js \
     backend/src/application/system-engineer-sdk-events.js \
     backend/src/application/owner-sdk-stream.js \
     backend/src/application/conversation-audit-history-service.js \
     ui/nextjs/lib/system-engineer-conversation-events.js \
     backend/tests/unit/conversation-plan-create.test.js \
     backend/tests/unit/conversation-plan-handoff.test.js \
     ui/nextjs/tests/system-engineer-conversation-stream.test.js
   ```

---

## 4. Khuyến nghị Vận hành

- Chạy `/r api` trên màn hình điều khiển để tiến trình Control API nạp các dịch vụ mới (`am-se-handoff-store.js`, `am-se-handoff-service.js`) trước khi thử nghiệm trực tiếp câu lệnh `tạo kế hoạch từ <file.md>, giao việc cho SL/SE` trên giao diện.

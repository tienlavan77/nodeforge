<!-- Đặc tả kỹ thuật để System Engineer (SE) triển khai cơ chế lập kế hoạch JSON-First hợp nhất (từ hội thoại hoặc file .md), phản biện kế hoạch giữa AM (người viết) và SE (người phản biện) cho mọi nhánh giao việc, và tự động giao việc cho SL hoặc SE. -->
# Đặc tả kỹ thuật: Unified JSON-First Planning (Chat / `.md`), Phản biện `AM ↔ SE` & Auto-Handoff (`SL` / `SE`)

## 1. Mục tiêu và bối cảnh

Chuẩn hóa toàn bộ quy trình lập kế hoạch của **Architecture Manager (AM)** về một chuẩn **JSON-First** duy nhất (`architecture_manager.architecture_plan.v1`), cho phép Owner khởi tạo kế hoạch từ **cuộc hội thoại hiện tại** hoặc từ **một file `.md` trong dự án**, đồng thời hỗ trợ **tự động giao việc (Auto-Handoff)** cho **Sprint Leader (`SL`)** hoặc **System Engineer (`SE`)** ngay trong câu lệnh:

1. **Nguồn đầu vào linh hoạt (`source`)**:
   - Từ cuộc hội thoại hiện tại (`source_kind: "conversation"`).
   - Từ file Markdown chỉ định (`source_kind: "markdown_file"`, ví dụ: `tạo kế hoạch từ docs/spec.md, giao việc cho SL` hoặc `tạo kế hoạch từ docs/spec.md, giao việc cho SE`).
2. **Mọi nhánh giao việc (`SL` hoặc `SE`) đều qua bước Phản biện & Thống nhất kế hoạch giữa `AM` (người viết kế hoạch) và `SE` (người phản biện kế hoạch)**:
   - `none` (mặc định khi không nêu đích giao việc): Tạo `PLAN-... r1` ở trạng thái `awaiting_human_approval` như hiện tại.
   - Khi có lệnh giao việc (`delivery_target === "sl"` hoặc `delivery_target === "se"`):
     - **Bước 1 — Phản biện & Thống nhất kế hoạch (1–2 vòng giữa `AM ↔ SE`)**: Trong **mọi nhánh giao việc**, **AM đóng vai trò người viết kế hoạch** và **SE đóng vai trò người phản biện kế hoạch**. Ngay sau khi tạo xong `r1`, AM trình bày kế hoạch bằng ngôn ngữ tự nhiên để SE khảo sát codebase và phản biện kỹ thuật; AM và SE trao đổi tối đa 1–2 vòng để thống nhất phương án cuối cùng (cập nhật kế hoạch sang `r2` nếu cần) và tự động approve bản kế hoạch đã chốt.
     - **Bước 2 — Chuyển giao thực thi theo đích (`delivery_target`)**:
       - **Nếu `delivery_target === "sl"` (`giao việc cho SL`)**: Sau khi `AM ↔ SE` đã thống nhất và approve kế hoạch, Node tự động gọi `handoffApprovedPlan` (kèm nội dung thống nhất giữa AM và SE) để **SL** sinh **Sprint Plan JSON** cùng danh sách **Tickets** ở trạng thái `ready`.
       - **Nếu `delivery_target === "se"` (`giao việc cho SE`)**: Sau khi `AM ↔ SE` đã thống nhất và approve kế hoạch, phiên làm việc chuyển sang giai đoạn **Thực thi & Nghiệm thu (`phase: "implementation"`)** — **SE** trực tiếp viết mã và chạy test; **AM** nghiệm thu đối chiếu với từng `outcomes[].acceptance_criteria` cho đến khi đạt `PASS`.
3. **Nguyên tắc Dual-Stream (Chỉ dual-stream phần trao đổi hội thoại giữa `AM ↔ SE`; phần dùng tool làm việc vẫn stream bình thường như hiện có)**:
   - **Phần trao đổi hội thoại (`text` / lời nói đối thoại giữa AM và SE)**: Được **dual-stream đồng thời trên cả 2 khung chat Architecture (`AM`) và System (`SE`)** để Owner đang đứng ở bất kỳ trang nào cũng đọc trọn vẹn cuộc thảo luận, phản biện, thống nhất và nghiệm thu giữa AM và SE.
   - **Phần dùng tool làm việc (`command_execution`, khối `RAN`, gọi tool tìm kiếm/đọc/sửa code `search_text`, `read_file`, `edit_diff`, chạy test...)**: **Vẫn giữ nguyên cơ chế stream bình thường như hiện có trên khung chat gốc của từng agent** (ví dụ SE gọi tool vẫn hiển thị đầy đủ các bước `RAN` trên trang `/system` tại `seConversationId`), nhưng **không phát chéo (không dual-stream)** sang khung chat của agent phía bên kia.

---

## 2. Nhận diện câu lệnh trong `conversation-plan-trigger.js`

### File cần cập nhật
- `backend/src/modules/governance/conversation-plan-trigger.js`

### Hợp đồng kỹ thuật
Bổ sung hàm `parseConversationPlanCreateTrigger(text)` (và giữ tương thích ngược cho `detectPlanCreateTrigger(text)`):

1. **Quy tắc quét dòng**: Giữ nguyên state machine loại trừ dòng nằm trong code fence (```` ``` ```` / `~~~`), dòng trích dẫn (`>`), dòng trống, hoặc câu hỏi kết thúc bằng `?` / `？`.
2. **Cấu trúc trả về của `parseConversationPlanCreateTrigger(text)`**:
   ```json
   {
     "line": "tạo kế hoạch từ docs/spec.md, giao việc cho SE",
     "source_kind": "markdown_file",
     "source_path": "docs/spec.md",
     "delivery_target": "se"
   }
   ```
   - `source_kind`: `"conversation"` | `"markdown_file"`.
   - `source_path`: `null` khi `source_kind === "conversation"`; chuỗi đường dẫn tương đối an toàn (bắt đầu bằng `docs/`, `workflows/`, `ARCHITECTURE.md` hoặc đường dẫn `.md` hợp lệ không chứa `..`, `\0`, `\\`) khi `source_kind === "markdown_file"`.
   - `delivery_target`: `"none"` | `"sl"` | `"se"`.
3. **Các mẫu câu lệnh tiếng Việt & tiếng Anh cần khớp**:
   - Nguồn hội thoại:
     - `tạo kế hoạch kiến trúc [và|, ] [giao việc cho (SE|SL|System Engineer|Sprint Leader)]`
     - `tạo kế hoạch từ cuộc trao đổi [và|, ] [giao việc cho (SE|SL|System Engineer|Sprint Leader)]`
     - `create/generate/draft/make [an/the] [new] architecture plan [and|, ] [hand off to / assign to / delegate to (SE|SL|System Engineer|Sprint Leader)]`
     - `create/generate/draft/make [an/the] [new] plan from (this|the) conversation [and|, ] [hand off to / assign to / delegate to (SE|SL|System Engineer|Sprint Leader)]`
   - Nguồn file `.md`:
     - `tạo kế hoạch [kiến trúc] từ [file] <path.md> [(và|,) giao việc cho (SE|SL|System Engineer|Sprint Leader)]`
     - `create/generate/draft/make [an/the] [new] [architecture] plan from [file] <path.md> [(and|,) (hand off to|assign to|delegate to) (SE|SL|System Engineer|Sprint Leader)]`
     - Cho phép `<path.md>` đặt trong dấu backtick `` `docs/a.md` `` hoặc ngoặc kép `"docs/a.md"`.
4. **Chống trộn lệnh**: `assertNoMixedPlanningApproval(text)` vẫn từ chối khi trộn dòng trigger tạo/cập nhật kế hoạch với dòng `/approve` độc lập. Cụm hậu tố `giao việc cho SL/SE` nằm ngay trong cùng một dòng lệnh tạo kế hoạch là `delivery_target` hợp lệ, không bị coi là lỗi `PLAN_APPROVAL_MIXED`.

---

## 3. Lập kế hoạch JSON-First hợp nhất trong `conversation-planning-service.js`

### File cần cập nhật
- `backend/src/application/conversation-planning-service.js`
- `backend/src/modules/governance/conversation-plan-source.js`
- `backend/src/application/owner-chat-command-service.js`

### Hợp đồng kỹ thuật
1. **Đọc và khóa nguồn `<file.md>`**:
   - Khi `parsedTrigger.source_kind === "markdown_file"`:
     - Kiểm tra tính hợp lệ của `source_path` (phải kết thúc bằng `.md`, thuộc project-relative path an toàn, không chứa `..`). Nếu sai định dạng, ném lỗi `PLAN_SOURCE_PATH_INVALID` (`statusCode: 400`).
     - Đọc nội dung file qua `fileService.readFile({ path: parsedTrigger.source_path })`. Nếu file không tồn tại hoặc rỗng, ném lỗi `PLAN_SOURCE_MISSING` (`statusCode: 409`).
     - Tính `source_file_sha256` (SHA-256 hex của nội dung file).
   - Lưu `conversation-intake.json` qua `retainConversationIntakeSource` với đầy đủ provenance:
     ```json
     {
       "schema_version": 1,
       "project_id": "<projectId>",
       "conversation_id": "<conversationId>",
       "trigger": "<line>",
       "source_kind": "markdown_file",
       "source_file_path": "docs/spec.md",
       "source_file_sha256": "<sha256>",
       "delivery_target": "se",
       "text": "<owner message + markdown file content>"
     }
     ```
2. **Đi qua quy trình 2 pha JSON-First chuẩn**:
   - **Pha 1 (Clarification Discovery)**: Gửi `clarificationPrompt(combinedSourceText)` tới AM. Nếu còn câu hỏi cần Owner quyết định, lưu session với `delivery_target` giữ nguyên trong intake anchor và trả trạng thái `awaiting_owner_decisions`.
   - **Pha 2 (Plan Generation `r1`)**: Khi `questions.length === 0` (hoặc khi Owner xác nhận qua `/plan-continue`), gửi `generationPrompt(combinedSourceText, decisions)` tới AM $\rightarrow$ parse qua `parseArchitecturePlanJSON` $\rightarrow$ lưu canonical JSON vào `.forge/runtime/nf/plans/<plan_id>/plan-source-r1.json` $\rightarrow$ render Markdown và lưu qua `markdownPlanStore.createRevision`.

---

## 4. Phản biện kế hoạch `AM ↔ SE` (1–2 vòng) & Tự động giao việc cho `SL` hoặc `SE`

### File mới cần tạo (đảm bảo mỗi file $\le 250$ `code_lines`)
- `backend/src/application/am-se-handoff-store.js`: Lưu trữ bền vững trạng thái phiên thảo luận & handoff tại `.forge/runtime/nf/se-handoffs/<projectId>/<handoffId>.json` (gồm `handoff_id`, `project_id`, `plan_id`, `plan_revision`, `plan_sha256`, `plan_source_path`, `delivery_target`: `"sl" | "se"`, `am_agent_id`, `se_agent_id`, `am_conversation_id`, `se_conversation_id`, `phase`: `"plan_critique" | "sl_handoff" | "implementation"`, `status`: `"critiquing" | "running" | "reviewing" | "completed" | "paused" | "failed"`, `critique_round`, `max_critique_rounds: 2`, `round`, `max_rounds: 5`, `history: []`).
- `backend/src/application/am-se-handoff-service.js`: Điều phối chung cho **cả 2 nhánh `delivery_target === "sl"` và `delivery_target === "se"`**:
  - **Giai đoạn 1 — Phản biện & Thống nhất kế hoạch giữa `AM` (người viết) và `SE` (người phản biện) (`phase: "plan_critique"`, 1–2 vòng — chạy cho cả nhánh `SL` và `SE`)**.
  - **Giai đoạn 2 — Chuyển giao thực thi theo `delivery_target`**:
    - Nhánh `delivery_target === "sl"`: Tự động approve bản kế hoạch đã thống nhất và giao cho **SL** (`handoffApprovedPlan`) tạo Sprint Plan & Tickets ở trạng thái `ready`.
    - Nhánh `delivery_target === "se"`: Chuyển sang `phase: "implementation"` (tối đa `max_rounds: 5`) để **SE** viết mã & chạy test, **AM** nghiệm thu (`PASS` / `REVISE`).

### 4.1. Giai đoạn 1 (Chung cho mọi nhánh giao việc `SL` và `SE`): Phản biện & Thống nhất kế hoạch giữa `AM ↔ SE` (1–2 vòng)
Ngay sau khi tạo xong `r1` và đọc thấy `intake.delivery_target` là `"sl"` hoặc `"se"`:
1. **Khởi tạo phiên phản biện `AM ↔ SE` (`startHandoff`, `phase = "plan_critique"`, `critique_round = 1`)**:
   - Xác định `seAgentId` đang bật (`agentRoleResolver.resolveProfile("system_engineer")?.agent_id`). Nếu chưa có SE bật, ném lỗi `SYSTEM_ENGINEER_UNAVAILABLE`.
   - Đảm bảo cuộc trò chuyện bên trang System tồn tại (`seConversationId = "CONV-SE-" + planId`, gọi `conversationCrudService.ensure({ id: seConversationId, project_id: projectId, agent_id: seAgentId, title: plan.title })`).
   - Lưu bản ghi vào `am-se-handoff-store.js` với `delivery_target` (`"sl"` hoặc `"se"`), `phase: "plan_critique"`, `status: "critiquing"`, `critique_round: 1`, `max_critique_rounds: 2`.
   - **Định dạng bản tin AM trình bày kế hoạch thân thiện với người đọc (`formatHumanReadableHandoffBrief(planJson, meta)`)**:
     - **Tuyệt đối không xả nguyên khối JSON thô (`plan-source-r1.json`) lên khung chat**. Bản tin AM gửi cho SE được dual-stream trên cả 2 khung chat (`Architecture` và `System`) bằng **ngôn ngữ tự nhiên, trình bày Markdown rõ ràng để Human dễ theo dõi**:
       - **Mục tiêu & Bối cảnh**: Nêu tên kế hoạch, mã `<plan_id> r1`, nguồn khởi tạo (hội thoại hoặc `<source_path>`), đích giao việc (`SL` hoặc `SE`), và mục tiêu chính (`objective`).
       - **Các hạng mục kết quả cần đạt (`outcomes`)**: Diễn giải từng `O1`, `O2`... gồm mô tả công việc, tiêu chí hoàn thành (`acceptance_criteria`), và các giới hạn cần tuân thủ (`guardrails`).
       - **Khu vực mã nguồn liên quan & Kiểm thử (`evidence` & `verification`)**: Nêu rõ các file tham chiếu và cách kiểm tra.
       - **Mời SE phản biện kế hoạch**: Ở cuối bản tin, AM (người viết kế hoạch) mời SE (người phản biện kế hoạch) khảo sát nhanh các file liên quan và cho ý kiến phản biện kỹ thuật (tính khả thi, điểm xung đột với code hiện tại, rủi ro hoặc đề xuất cải thiện cấu trúc `outcomes`/`guardrails`) trước khi chốt phương án giao việc. Đính kèm 1 dòng đường dẫn gọn (`_Hồ sơ kế hoạch gốc: .forge/runtime/nf/plans/<plan_id>/plan-source-r1.json_`).
   - Phát bản tin mở đầu của AM lên cả `amConversationId` và `seConversationId`, đồng thời kích hoạt lượt phản biện vòng 1 của SE trên `seConversationId` với `linkedConversationId: amConversationId` (trong giai đoạn `plan_critique`, prompt nhắc SE chỉ dùng các công cụ đọc/tìm kiếm code để khảo sát và phản biện kế hoạch bằng ngôn ngữ tự nhiên, chưa sửa file).

2. **Xử lý 1–2 vòng phản biện giữa `AM ↔ SE` (`onSystemEngineerCritiqueCompleted`)**:
   - SE gửi nhận xét phản biện bằng ngôn ngữ tự nhiên (được dual-stream phần lời nói sang cả trang `Architecture`) kèm nhãn trạng thái ở dòng cuối:
     - `[CRITIQUE: ALIGNED]`: SE hoàn toàn đồng thuận với kế hoạch.
     - `[CRITIQUE: DISCUSS]`: SE có điểm cần AM làm rõ hoặc đề xuất điều chỉnh.
   - `am-se-handoff-service` gọi AM xem xét ý kiến của SE:
     - **Nếu cần trao đổi thêm ở vòng 1 (`[CRITIQUE: DISCUSS]` và `critique_round < max_critique_rounds`)**:
       - AM giải đáp băn khoăn của SE bằng ngôn ngữ tự nhiên trên cả 2 khung chat (và nếu đề xuất của SE hợp lý, AM cập nhật luôn bản kế hoạch sang `r2` qua RFC 7396 JSON Merge Patch trong `conversation-plan-source.js` và `markdownPlanStore.createRevision`), tăng `critique_round += 1` (sang vòng 2), và mời SE xác nhận lần cuối.
     - **Nếu đã đồng thuận ở vòng 1 (`[CRITIQUE: ALIGNED]`) hoặc đã hoàn tất vòng 2 (`critique_round >= max_critique_rounds`)**:
       - Nếu có điều chỉnh hợp lý ở vòng 2, AM cập nhật revision mới nhất cho bản kế hoạch.
       - Tự động ghi nhận quyết định approve của Owner cho revision đã thống nhất:
         ```js
         await markdownPlanStore.decide({
           planId,
           revision: latestRevision,
           sha256: latestSha256,
           decision: "approved",
           approverId: approvedOwnerId,
           comments: `Auto-approved after AM-SE plan critique (${critique_round} round(s)).`
         });
         ```
       - AM đăng thông báo **Chốt thống nhất kế hoạch giữa AM & SE** rõ ràng bằng ngôn ngữ tự nhiên lên cả 2 khung chat (`amConversationId` và `seConversationId`), sau đó chuyển sang **Giai đoạn 2** tùy theo `delivery_target`.

### 4.2. Giai đoạn 2 — Nhánh `delivery_target === "sl"` (Giao việc cho `SL` sinh Sprint Plan & Tickets)
Ngay sau khi `AM ↔ SE` chốt thống nhất và auto-approve bản kế hoạch ở Mục 4.1:
1. Chuyển trạng thái handoff sang `phase: "sl_handoff"`, `status: "running"`.
2. Gọi `approvePlan({ planId, conversationId: amConversationId, approvedOwnerId, approvalRevision: latestRevision, approvalSha256: latestSha256 })` (hoặc `handoffApprovedPlan` trực tiếp kèm tóm tắt nội dung thống nhất giữa AM & SE):
   - `sprintPlanLeader.requestPlan` sinh **Sprint Plan JSON** và danh sách **Tickets** dựa trên bản kế hoạch đã được AM & SE phản biện thống nhất.
   - Nạp vào `sprintOrchestration.ingestAgentCompletion` và đặt trạng thái Sprint trong `sprintRegistry` thành `"ready"`.
3. Cập nhật phiên handoff sang `status: "completed"`, đăng thông báo hoàn tất giao việc cho SL (nêu rõ mã kế hoạch, mã Sprint `<sprint_id>`, số lượng Tickets ở trạng thái `ready`) lên khung chat và phát sự kiện `planEvents` để trang `/coding` hiển thị ngay Sprint & Tickets mới.

### 4.3. Giai đoạn 2 — Nhánh `delivery_target === "se"` (Giao việc cho `SE` thực thi viết mã & `AM` nghiệm thu)
Ngay sau khi `AM ↔ SE` chốt thống nhất và auto-approve bản kế hoạch ở Mục 4.1:
1. Chuyển trạng thái handoff sang `phase: "implementation"`, `status: "running"`, `round: 1` và kích hoạt lượt thực thi viết mã đầu tiên của SE trên `seConversationId` (với `linkedConversationId: amConversationId`).
2. **Vòng lặp Thực thi & AM nghiệm thu (`onSystemEngineerTurnCompleted`, tối đa `max_rounds: 5`)**:
   - Khi SE hoàn tất một lượt viết mã và chạy test, `am-se-handoff-service` chuyển trạng thái sang `"reviewing"` và gọi AM (dùng các Forge read-only tools: `read_file`, `read_lines`, `search_text`, `git_status`, `git_diff`) đối chiếu kết quả thực tế với từng `outcomes[].acceptance_criteria`.
   - AM viết nhận xét nghiệm thu bằng ngôn ngữ tự nhiên, dễ hiểu cho Human (tóm tắt kết quả vòng hiện tại, đánh dấu rõ hạng mục **Đã đạt** / **Cần chỉnh sửa thêm**) kèm nhãn điều phối ở dòng cuối (`[VERDICT: PASS]` hoặc `[VERDICT: REVISE]`):
     - **`PASS`**: Mọi tiêu chí nghiệm thu đều đạt $\rightarrow$ cập nhật handoff sang `"completed"`, phát thông báo nghiệm thu hoàn tất lên cả 2 khung chat (`amConversationId` và `seConversationId`).
     - **`REVISE`** (và `round < max_rounds`): Còn tiêu chí chưa đạt hoặc test lỗi $\rightarrow$ phát nhận xét hướng dẫn của AM lên cả 2 khung chat, tăng `round += 1`, và tự động gọi SE thực hiện lượt sửa tiếp theo.
     - Nếu chạm `max_rounds` (mặc định 5) mà chưa `PASS` hoặc khi Owner bấm **Pause / Stop**, dừng ở trạng thái `"paused"` và tóm tắt rõ những gì đã xong / những gì còn vướng để Owner quyết định.

---

## 5. Dual-Stream UI trên trang Architecture và trang System (Dual-Stream phần trao đổi; giữ nguyên stream tool làm việc hiện có)

### Các file cần cập nhật
- `backend/src/application/system-engineer-sdk-events.js`
- `backend/src/application/conversation-audit-history-service.js`
- `ui/nextjs/lib/system-engineer-conversation-events.js`
- `ui/nextjs/lib/home-page-event-stream.js`
- `ui/nextjs/components/architecture-workspace.jsx`

### Hợp đồng kỹ thuật
1. **Giữ nguyên stream phần dùng tool làm việc trên kênh chính; chỉ dual-stream phần trao đổi hội thoại sang kênh liên kết**:
   - Trong `withSystemEngineerEvents` (`backend/src/application/system-engineer-sdk-events.js`), nhận thêm `linkedConversationId` (từ `payload.linked_conversation_id`) và đính kèm `linked_conversation_id: linkedConversationId ?? null` vào `payload` của sự kiện `agent.activity` (cả `conversation_turn` và `command_execution`) cũng như khi ghi audit log:
     - **Không cắt bỏ `command_execution` hay tool entries ở backend** để trang **System (`/system`)** nơi `payload.conversation_id === activeConversationId` **vẫn stream đầy đủ và bình thường mọi bước làm việc dùng tool (`RAN`, `search_text`, `read_file`, `edit_diff`, chạy test...) như hiện có**.
   - Đối với **AM**: Các bước dùng tool của AM trên khung `amConversationId` vẫn hoạt động bình thường như hiện có; còn các tin nhắn trao đổi hội thoại (`conversation.message.delta` / `conversation.message.received` / `conversation.message.completed`) của AM trong phiên handoff được phát đồng thời vào cả `amConversationId` và `seConversationId`.
   - Trong `conversation-audit-history-service.js`:
     - Khi truy vấn lịch sử cho kênh chính (`record.conversation_id === conversationId`): trả về đầy đủ cả tin nhắn trao đổi lẫn các bước gọi tool làm việc như hiện có.
     - Khi truy vấn lịch sử qua kênh liên kết (`record.content?.linked_conversation_id === conversationId` mà `record.conversation_id !== conversationId`): chỉ lấy phần trao đổi hội thoại (lọc bỏ `sdk_event.type === "command_execution"` và trong `conversation_turn` chỉ giữ các mục `entry.type === "text"`).
2. **Hiển thị trên Frontend (`ArchitectureWorkspace` và `SystemPage`)**:
   - Trong `ui/nextjs/lib/system-engineer-conversation-events.js`, hàm `appendSystemEngineerConversationEvent(messages, event, conversationId, nickname)`:
     - **Khi sự kiện thuộc kênh chính của SE (`event.payload?.conversation_id === conversationId`)**: Giữ nguyên 100% hành vi hiện có — stream bình thường cả phần trao đổi (`text`) lẫn phần dùng tool làm việc (`command_execution` / khối `RAN`).
     - **Khi sự kiện đến từ kênh liên kết (`event.payload?.linked_conversation_id === conversationId` trên trang Architecture)**: Chỉ dual-stream phần trao đổi hội thoại — bỏ qua `sdk_event.type === "command_execution"`, và trong `conversation_turn` chỉ giữ lại các `entries` có `entry.type === "text"` (nếu lượt đang chạy mới chỉ có tool call mà chưa có `text`, chưa tạo bong bóng chat bên trang Architecture).
   - Trong `ui/nextjs/lib/home-page-event-stream.js`, cập nhật bộ lọc sự kiện để nhận diện cả `payload.linked_conversation_id === activeConversationIdRef.current`.
   - Trong `ui/nextjs/components/architecture-workspace.jsx`, import `SystemEngineerReply`: khi `message.se_event?.type === "conversation_turn"`, render `<SystemEngineerReply key={message.stream_key ?? message.id} message={message} displayMessageTime={displayMessageTime} onMarkdownOpen={setMarkdownPreviewPath} />` để hiển thị phần lời nói trao đổi của SE ngay trong khung chat Architecture.

---

## 6. Kiểm thử nghiệm thu (Verification) dành cho SE

SE cần bổ sung và chạy pass các bài test mục tiêu sau:
1. **Unit test bộ phân tích câu lệnh (`backend/tests/unit/conversation-plan-create.test.js`)**:
   - Khớp chính xác 4 tổ hợp: `(conversation | <file.md>)` $\times$ `(none | SL | SE)` bằng cả tiếng Việt và tiếng Anh.
   - Đảm bảo câu hỏi (`?`), blockquote (`>`) và code fence (```` ``` ````) không kích hoạt nhầm.
2. **Unit & Integration test Phản biện kế hoạch `AM ↔ SE` và Auto-Handoff (`backend/tests/unit/conversation-plan-handoff.test.js`)**:
   - **Nhánh `giao việc cho SL`** (từ hội thoại hoặc từ `<file.md>`): tạo `PLAN-... r1` $\rightarrow$ chạy giai đoạn phản biện & thống nhất kế hoạch 1–2 vòng giữa **`AM` (người viết) và `SE` (người phản biện)** (`phase: "plan_critique"`) $\rightarrow$ tự động approve bản kế hoạch đã thống nhất và gọi `handoffApprovedPlan` để **SL** tạo Sprint & Tickets ở trạng thái `ready`.
   - **Nhánh `giao việc cho SE`** (từ hội thoại hoặc từ `<file.md>`): tạo `PLAN-... r1` $\rightarrow$ chạy giai đoạn phản biện & thống nhất kế hoạch 1–2 vòng giữa **`AM ↔ SE`** (`phase: "plan_critique"`, kiểm tra cả nhánh `[CRITIQUE: ALIGNED]` sau 1 vòng và `[CRITIQUE: DISCUSS]` qua 2 vòng) $\rightarrow$ chuyển sang giai đoạn thực thi viết mã (`phase: "implementation"`), chạy vòng lặp AM nghiệm thu (`REVISE` $\rightarrow$ `PASS`) và kết thúc ở trạng thái `completed`.
3. **UI Stream test (`ui/nextjs/tests/system-engineer-conversation-stream.test.js`)**:
   - Trên khung chat gốc của SE (`payload.conversation_id === activeConversationId`), cả phần trao đổi (`text`) và phần dùng tool làm việc (`command_execution` / `RAN`) vẫn stream bình thường như hiện có.
   - Trên khung chat liên kết phía AM (`payload.linked_conversation_id === activeConversationId`), chỉ dual-stream phần trao đổi hội thoại (`entry.type === "text"`), không hiển thị các bước gọi tool làm việc (`command_execution`).

<!-- Điều chỉnh UX recovery tối giản cho Architecture và System, gồm interruption do provider/backend lỗi. -->
# Plan: Recovery tối giản sau interruption ở statusbar conversation

> **Trạng thái:** revision 4, đề xuất architecture chưa được duyệt. Architecture dùng session/client authorization hiện có như System: không nhập owner token hay bất kỳ token thủ công nào. Revision này giữ các trigger interruption đã chốt và bổ sung khoảng hở thị giác rõ ràng giữa conversation statusbar với Home composer; không thay thế identity/revision/SHA của các plan pause/resume trước đó.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Controls hiện có xử lý Esc x2 và đọc recovery record lúc mount, nhưng khi agent lỗi ở backend/provider (ví dụ HTTP 429, 500, 404), owner cần thấy lỗi trong Agent Activity và recovery ngay, không cần reload hoặc chờ lease hết hạn.
- **Kết quả:** Khi Esc x2 hoặc một lỗi terminal của backend/provider kết thúc execution, backend ghi durable status an toàn (`interrupted` hoặc `manual_required` theo guardrail hiện có), phát activity lỗi đã sanitize tới đúng conversation/workspace, và UI đồng bộ execution ngay. Với record `interrupted`, bên phải `ConversationProjectGit` hiển thị duy nhất **`One action interrupted`** cùng ba nút **Continue**, **Restart**, **Discard**.
- **Giá trị:** Trạng thái lỗi, activity và recovery nhất quán; owner có thể quyết định tiếp tục, chạy lại, hoặc bỏ attempt tại vị trí đã chốt.

## 2. Phạm vi

### In scope

- Áp dụng UX và failure path giống nhau cho Architecture (`architecture_manager`) và System (`system_engineer`), không có token-entry ở Architecture.
- Giữ Esc x2: Esc đầu chỉ arm/hint; Esc thứ hai trong cửa sổ hiện có yêu cầu pause đúng active execution, chống repeat/IME/dialog/rename và duplicate request.
- Với lỗi từ agent execution backend/provider, gồm response HTTP 429/500/404 và lỗi SDK/transport được normalizer nhận diện: persist failure outcome trước, rồi phát một `agent.activity` failure event có `project`, `conversation`, `correlation/execution`, agent identity và error code/summary an toàn.
- Agent Activity panel chỉ hiển thị activity thuộc role/workspace và conversation liên quan; lỗi tới đúng panel ngay khi event SSE đến, không yêu cầu user reload. Không hiển thị credential, request body, provider raw response, stack trace hay internal path.
- Controls đang active phải refresh/sync record khi nhận failure/checkpoint/activity event cho execution của conversation; chỉ render strip sau khi durable record trả `interrupted`.
- Render message và ba action recovery ở phần bên phải cùng hàng với `ConversationProjectGit`; di chuyển thay vì nhân đôi controls ở header.
- Conversation statusbar phải tách khỏi viền/khối `HomeChatComposer` bằng một khoảng hở dọc nhìn thấy được ở cả Architecture và System. Statusbar vẫn thuộc composer wrapper để giữ bề rộng/căn lề workspace, nhưng không được trông như dính vào input; khoảng hở không làm statusbar đè pending queue, helper text hoặc nội dung chat.
- Ba nút giữ `continue`, `restart`, `discard`, đúng `projectId`, `conversationId`, `executionId`, pending/disabled/error state và idempotency hiện có.

### Out of scope

- Không biến mọi activity/tool failure thành interruption: lỗi tool recoverable trong một execution chỉ theo lifecycle/checkpoint hiện hữu; chỉ execution-ending failure mới phát recovery.
- Không đổi endpoint, payload recovery, authorization policy, execution/checkpoint storage model, role policy, semantics Continue/Restart/Discard, hay `.forge/`.
- Không tự Continue/Restart, không tự tạo `interrupted` ở client, không thêm modal, confirmation, retry policy, history/step counter, token-entry flow hoặc redesign statusbar/monitor.

## 3. Hướng tiếp cận và guardrails

- **Source of truth và thứ tự:** backend `owner-sdk-stream` hiện catch lỗi, cập nhật checkpoint `running` thành `interrupted` (hoặc `manual_required` nếu có mutation chưa chắc chắn), rồi propagate lỗi. Delivery phải bảo đảm persist thành công trước khi publish activity/recovery notification; UI chỉ enable controls sau khi đọc record durable. Nếu persist thất bại, không quảng cáo recovery thành công; log/hiển thị generic operational failure theo policy hiện có.
- **Phân loại lỗi:** provider HTTP 429/500/404, timeout, SDK/transport và normalized provider errors là failure candidates. Không suy luận từ text lỗi ở browser. Cần có stable, bounded public error code/category (ví dụ provider response/transport/timeout), HTTP status chỉ khi đã được backend xác thực và policy cho phép; summary là thông báo user-safe. Raw `error.message`, headers, credentials, prompts, stack/cause và provider body không được đưa vào SSE/UI.
- **Activity event:** dùng project stream `agent.activity` hiện có, với `status: failed`, conversation/correlation/execution linkage và agent role identity để `WorkspaceMonitorPanels` lọc đúng role. Event phải được phát tối đa một lần cho mỗi terminal failure execution (dedupe bằng execution/correlation + terminal transition), không phát nếu failure đã được thay bằng successful completion.
- **Đồng bộ UI:** dùng project-stream event hiện có hoặc checkpoint notification để invalidation/refetch scoped `listOwnerExecutions(projectId, conversationId)`. SSE là tín hiệu refresh, checkpoint record là authority; bỏ qua event sai project/conversation/execution, event duplicate và event đến sau unmount. Nếu refetch tạm lỗi, hiện lỗi quan sát được và cho retry, không render buttons dựa chỉ vào event.
- **Recovery an toàn:** Continue/Restart/Discard qua `decideOwnerExecution`, `inFlight` guard và server reconciliation. `manual_required` giữ gate/reconcile hiện có; không được show ba nút như bypass cho record này. `continue` unavailable khi provider session không có vẫn theo error contract hiện có; Restart/Discard không đổi semantics.
- **Không nhập token:** controls Architecture/System hiện gọi client list/decision không truyền `ownerToken`; delivery không thêm input/prompt token hoặc `ownerToken` prop. Session/server authorization hiện hữu giữ nguyên.
- **Bố cục statusbar/composer:** duy trì DOM placement hiện có trong `.claude-composer-wrap`; áp dụng spacing ở stylesheet dùng chung cho hai trang, không thêm wrapper/positioning tuyệt đối chỉ để tạo khoảng hở. Khoảng hở là một layout token/rule nhất quán, responsive co được nhưng không về 0; statusbar wrap được trên viewport hẹp mà không va chạm composer, pending queue hay helper copy.
- **Text quyết định:** visible text chính xác `One action interrupted`; accessible names: `Continue interrupted action`, `Restart interrupted action`, `Discard interrupted action`. Không dùng typo `interupt` trong code/UI.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `backend/src/application/owner-sdk-stream.js` | Catch execution failure hiện patch record thành `interrupted`/`manual_required`; ghi `owner.sdk_failed`, nhưng evidence hiện có chưa chứng minh một activity failure event riêng cho terminal provider failure | Đã đọc, SHA `3a27f5…b7c5` |
| `backend/src/application/owner-execution-checkpoint.js` | Durable checkpoint, stale lease classification và mutation/manual-review guard | Đã đọc, SHA `6565b0…c5d8` |
| `backend/src/application/owner-execution-control.js` | Role-scoped listing và recovery decisions chỉ cho record `interrupted` | Đã đọc, SHA `da73e1…560b` |
| `backend/src/transport/sse/project-stream*.js` | Project stream đã hỗ trợ `agent.activity`; cần SL xác minh publish path/correlation before manifest | Search evidence; chưa đọc toàn source |
| `ui/nextjs/components/{architecture,system}-execution-controls.jsx` | Esc x2, in-flight guard, list/decision và header render hiện hữu; refresh hiện mount-scoped | Đã đọc, SHA `fd659d…bc52`, `b89d6c…a870` |
| `ui/nextjs/lib/project-stream-{client,event}.js` | Browser validates/deduplicates `agent.activity`; suitable invalidation signal | Đã đọc, SHA `8aef2e…e8ad`, `1821c7…55b3` |
| `ui/nextjs/components/WorkspaceMonitorPanels.jsx`, `lib/monitor-agent-activities.js` | Agent Activity monitor and role filtering anchor | Đã đọc, SHA `4c371b…9652`, `1ba7ba…1f67` |
| `ui/nextjs/app/page.jsx`, `ui/nextjs/app/system/page.jsx`, `components/conversation-project-git.jsx` | Both pages place project/git plus recovery controls in `.conversation-statusbar`, immediately before `HomeChatComposer` inside `.claude-composer-wrap` | Read current pages: SHA `309170…a478`, `66d67b…43f6`; git component remains revalidation target |
| `ui/nextjs/app/styles/home-workspace.css`, `app/styles/responsive-workspace.css` | Composer container currently has padding but no explicit statusbar-to-composer separation; responsive statusbar already wraps | Read current styles: statusbar SHA `7be327…f17f`; composer spacing search evidence, exact stylesheet revalidation required |

Candidate paths định hướng discovery, không là mutable-file allowlist.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Intentional interruption bằng Esc x2 | Esc đầu arm/hint; Esc thứ hai chỉ pause một lần active execution. IME, held/repeat Escape, dialog/rename và inactive conversation không kích hoạt. API contract không đổi. | Execution lifecycle hiện hữu |
| O2 | Backend/provider failure quan sát được ngay | Với một execution active, simulated normalized provider failures gồm 429, 500 và 404 tạo durable `interrupted` khi an toàn, hoặc giữ `manual_required` khi checkpoint yêu cầu. Mỗi terminal failure phát đúng một role/conversation-scoped Agent Activity failure event sau persist; activity có summary/code safe, không secret/raw provider detail. | Persist trước publish; dedupe; no sensitive leakage |
| O3 | Recovery strip cạnh project/git | Khi UI nhận failure signal và refetch xác nhận active record `interrupted`, statusbar bên phải `ConversationProjectGit` hiển thị đúng `One action interrupted` + Continue/Restart/Discard, không reload; header không còn controls recovery trùng. Narrow viewport và screen reader vẫn dùng được. | Durable record, not event-only UI |
| O4 | Recovery bình thường, token-free, role-scoped | Architecture và System dùng session authorization; không token UI/prompt/`ownerToken` prop. Mỗi action gửi đúng một decision, disabled khi gửi; success/error rõ. `manual_required`, reconciliation, optimistic/SSE/conversation queue không đổi. | `inFlight`, server authorization/reconciliation |
| O5 | Statusbar và composer có khoảng hở rõ ràng | Cả Architecture lẫn System đặt statusbar/recovery phía trên Home composer với vertical gap quan sát được ở desktop và narrow viewport; statusbar không dính vào border composer, không overlap pending queue/helper, không thay đổi thứ tự tab hoặc vị trí recovery cạnh Git. | CSS dùng chung, DOM placement giữ nguyên |
| O6 | Regression coverage | Backend tests cover persist-before-event, dedupe, safe failure projection và 429/500/404. UI tests cover activity display/filtering, SSE-triggered refetch, statusbar placement/text/a11y, spacing statusbar–composer ở hai workspace và narrow layout, Esc guards, no duplicate header controls, action error wiring, manual-required exclusion và token-free Architecture/System. | No silent catch; current file policy |

**Gợi ý delivery (không bắt buộc):** SL có thể tách failure-event/durable transition contract khỏi UI invalidation/presentation; integration verification chạy sau khi hai phần ghép lại.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Emit activity trước checkpoint persist tạo controls false-positive | Major | Existing catch patch then throws, but terminal activity publish path needs verification | O2 enforces persist-before-publish and UI refetch |
| Raw provider 429/500/404 response leaks secrets or sensitive request data | Major | `owner.sdk_failed` currently receives error code; raw error shape varies by SDK | Stable sanitized projection; security escalation if a safe mapping cannot be proven |
| Failure event reaches wrong workspace/conversation | Major | Project stream carries conversation/correlation fields; monitor currently role filters | Include scoped identity; validate/filter client-side; test cross-role/conversation isolation |
| Duplicate activity or stale event causes duplicate recovery/UI | Major | SSE client dedupes event IDs, but producer-level terminal dedupe still needs validation | O2 producer dedupe; O3 durable record authority |
| Architecture mutation has uncertain state | Major | Checkpoint already classifies such state as `manual_required` | Never expose recovery strip as bypass; retain reconciliation gate |
| Statusbar vẫn chạm composer ở breakpoint hẹp | Minor | Hai page dùng cùng DOM; `.conversation-statusbar` đã `flex-wrap`, composer styles chưa định nghĩa gap riêng | Shared CSS spacing có minimum responsive; kiểm tra visual/DOM ở cả hai workspace |
| User phrase `interupt` is typo | Minor | English standard is `interrupted` | Exact visible text already decided |

## 7. Acceptance criteria của plan

- [ ] O1–O6 cover Esc x2 and backend/provider failures, immediate Agent Activity, durable recovery sync, and a distinct statusbar-to-composer gap.
- [ ] Architecture remains token-free and parity with System is maintained.
- [ ] No backend recovery contract/authorization/`.forge` semantics are widened; safe error projection and lifecycle guards are preserved.
- [ ] Facts repository-specific carry evidence; stated unverified publish/mount paths remain discovery work for SL.
- [ ] SL only creates SP after exact human approval of this file, revision 3 and its SHA-256; plan approval is not RUN/dispatch.

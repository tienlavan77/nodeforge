<!-- Business purpose: define the single implementation plan for converging NodeForge UI, shared contracts, responsive behavior, memory presentation, and verification. -->
# Plan: NodeForge UI Convergence — Canonical Chat, Responsive Workspace và Contract Verification

## 1. Mục tiêu

Hợp nhất UI NodeForge về một flow canonical, lấy `ui/nextjs/app/page.jsx` làm entry chính; loại bỏ đường dẫn legacy/duplicate có kiểm soát; chuẩn hóa primitive và contract dùng chung; sau đó triển khai layout desktop/tablet/mobile, conversation memory, Git status và kiểm chứng bằng unit/API/Playwright.

Phạm vi này bao gồm đầy đủ 8 yêu cầu bổ sung:

1. Canonical UI là `app/page.jsx`.
2. Audit, deprecate và loại bỏ legacy/duplicate components.
3. Dialog/modal primitive dùng chung.
4. Notification và error handling thống nhất.
5. CSS tách theo domain.
6. Mobile Agents page.
7. UI contract cho conversation memory.
8. Playwright smoke tests cho chat, agent management và memory drawer.

Không triển khai theo các nhánh UI độc lập. Mỗi phase phải cập nhật import graph, contract và verification tương ứng.

## 2. Quyết định kiến trúc

- `ui/nextjs/app/page.jsx` là owner duy nhất của home/canonical workspace flow.
- `NodeForgeApp.jsx`, `NodeForgeShell.jsx`, `NodeForgePanels.jsx` và các flow trùng chỉ được giữ nếu có dependency được chứng minh; nếu không, migrate rồi deprecate/remove.
- Conversations có một implementation canonical; `ConversationsAccordion` và `ConversationsBlock` phải được phân vai rõ ràng (desktop region hoặc mobile drawer), không cùng sở hữu một state.
- Modal/dialog, toast/notification, error normalization và responsive tokens là shared foundation.
- Backend event/SSE, optimistic message, retry, conversation state và project/task scope không được thay đổi chỉ để phục vụ refactor UI.
- Memory UI chỉ hiển thị projection đã sanitize và có scope; không dump raw transcript/event vào message history.

## 3. Phase 0 — Baseline, canonicalization và dependency graph

### Công việc

- Lập inventory route, component, hook, CSS class và state owner hiện tại.
- Vẽ import/dependency graph cho `page.jsx`, `NodeForgeApp`, `NodeForgeShell`, `NodeForgePanels`, overlays, conversation components, modal components.
- Chốt bảng phân loại: `canonical`, `migrate`, `deprecated`, `remove`.
- Xác định một owner cho conversation selection, message history, SSE subscription, workspace context và responsive drawer state.
- Ghi rõ các behavior phải bảo toàn: switch conversation, optimistic send, retry, stream correlation, project/task isolation.
- Không xóa file trước khi mọi import/route/test reference đã được xử lý.

### Gate

- Có canonical component map và import graph.
- Không còn quyết định dựa trên tên file בלבד; mỗi component bị deprecate có lý do và replacement.
- `page.jsx` render được flow hiện tại hoặc có migration ticket rõ ràng.

## 4. Phase 1 — Shared UI foundations

### 4.1 Dialog/modal primitive

Tạo primitive dùng chung với:

- portal và stacking policy;
- Escape và click-outside configurable;
- focus trap, restore focus, keyboard navigation;
- `aria-labelledby`, `aria-describedby`, role và initial focus;
- dialog, confirmation dialog và drawer/bottom-sheet variants;
- loading/submit/error state không làm mất focus ngoài ý muốn.

Migrate `AddAgentModal`, `CreateConversationModal`, connection/delete dialogs, sprint/ticket/settings/history dialogs. Không để modal implementation độc lập sau migration nếu không có exception được ghi nhận.

### 4.2 Notification và error contract

- Chuẩn hóa backend error thành `{ code, message, recoverable, scope, requestId }` ở UI boundary.
- Dùng notification provider/toast cho global success/info/warning; dùng inline error gần composer hoặc domain action cho lỗi thao tác.
- Có retry action cho lỗi recoverable; không dùng `alert()` và không render raw JSON/event.
- Giữ redaction: không hiển thị secret, token, remote URL nhạy cảm hoặc stack trace.
- Tái sử dụng `notification-formatter.js` như formatter, không coi formatter là UI contract hoàn chỉnh.

### 4.3 CSS theo domain

Tách contract/style theo tối thiểu:

- shell/layout và responsive tokens;
- conversations;
- chat/message/composer;
- workspace/context;
- sprint/ticket;
- agents;
- dialogs/drawers;
- notifications/errors.

Mỗi domain có naming rõ ràng, không phụ thuộc selector legacy ngoài compatibility layer tạm thời. Xóa compatibility layer sau khi migration và smoke test hoàn tất.

## 5. Phase 2 — Canonical desktop workspace và Chat

- Giữ desktop luôn hiển thị Conversations, Chat, Workspace và Sprint.
- Conversations nằm ở vùng riêng, không nằm phía trên message history.
- Chat không tự chiếm toàn bộ màn hình; composer luôn ở đáy Chat.
- Mỗi vùng có scroll độc lập; đo `scrollWidth`, overflow và chiều cao thực tế.
- Bảo toàn switch conversation, history loading, optimistic message, SSE routing, retry và stream cancellation.
- Mọi event phải được lọc theo `project_id`, `conversation_id`, `task_id` và agent scope phù hợp.
- Git indicator có state rõ ràng: clean, dirty, ahead/behind, no-upstream, detached HEAD, unavailable/error; không lộ remote URL.

## 6. Phase 3 — Responsive behavior và mobile Agents

### Desktop

Giữ nguyên bốn vùng chính và các scroll boundary đã chốt.

### Tablet

Workspace chuyển thành drawer; Chat vẫn là vùng thao tác chính; Conversations không bị đẩy vào message history.

### Mobile

- Chat là vùng mặc định.
- Conversations, Context/Workspace và Sprint mở qua drawer/accordion.
- Drawer có focus management, Escape, restore focus và trạng thái loading/error.
- Chuyển breakpoint không reset conversation, messages, draft, optimistic state, selected agent/task hoặc memory state.

### Agents page

- Card layout một cột, header/action responsive, không overflow ngang.
- Add/edit/test/delete dùng shared dialog hoặc bottom-sheet primitive.
- Có loading, empty, error và retry state.
- Kiểm tra keyboard/focus trên mobile và thao tác khi viewport hẹp.

## 7. Phase 4 — Conversation memory UI contract

UI chỉ tiêu thụ memory projection có schema tối thiểu:

```text
scope: { workspace_id, project_id, agent_id?, conversation_id?, task_id? }
memory_count
stable_context
 dynamic_context
context_revision
context_checksums
sources[]
stale: boolean
last_updated
actions: { refresh, rebuild? }
```

Yêu cầu:

- Hiển thị count, revision/checksum, source/reference và stale state.
- Refresh/rebuild yêu cầu scope và permission phù hợp; trạng thái pending/success/error phải rõ.
- Không trộn memory vào transcript; không tự suy đoán scope từ client state.
- Memory drawer giữ state khi đổi conversation/breakpoint và không làm mất draft/chat history.
- Contract phải tương thích với workflow memory hiện hữu (`memory.search/get/summarize/forget`), nhưng UI không tự expose purge/forget nếu chưa có confirmation và authorization contract.

## 8. Phase 5 — Verification trước khi cleanup

### Unit và contract

- Unit test state mapping cho clean/dirty/ahead-behind/no-upstream/detached/unavailable.
- API contract test Git status và error redaction.
- Test conversation switching, state preservation và SSE routing theo scope.
- Test dialog focus/Escape/click-outside/restore focus.
- Test notification normalization và retry semantics.
- Test memory projection, stale state, revision/checksum và scope isolation.

### Playwright smoke tests

Thêm suite tối thiểu:

1. **Chat**: load canonical page, switch conversation, send Enter, Shift+Enter, composer ở đáy, optimistic message, stream/error/retry.
2. **Agent management**: mở `/agents` ở mobile, add/edit/test/delete, dialog focus, validation, loading/error.
3. **Memory drawer**: mở/đóng, render projection, stale/refresh, giữ state khi đổi conversation và breakpoint.

### Responsive/accessibility smoke

Chạy desktop/tablet/mobile; kiểm tra `scrollWidth`, overflow, scroll container, chiều cao composer và drawer focus. Xác minh không mất Sprint/Workspace/conversation state khi chuyển breakpoint.

## 9. Phase 6 — Cleanup và release gate

- Chỉ sau khi test pass mới remove legacy components/imports/styles.
- Kiểm tra không còn route dùng legacy shell và không còn modal implementation trùng.
- Cập nhật component map, README/workflow và migration notes.
- Chạy lại lint, unit, API contract và Playwright smoke suite.
- Ghi rõ known exceptions, nếu có, cùng owner và ngày loại bỏ.

## 10. Acceptance criteria

- `app/page.jsx` là canonical UI và là entry duy nhất của home workspace.
- Không còn duplicate/legacy flow active ngoài exception được phê duyệt.
- Dialog, notification, error và CSS domain dùng contract chung.
- Desktop hiển thị Conversations, Chat, Workspace, Sprint; Chat không full-screen; composer ở đáy.
- Tablet dùng Workspace drawer; mobile mặc định Chat và mở được Conversations, Context, Sprint.
- Mỗi vùng scroll độc lập; không overflow ngang ngoài chủ ý.
- SSE, optimistic message, retry, conversation switching và state preservation không bị phá vỡ.
- Git indicator xử lý đủ clean, dirty, ahead/behind, no-upstream, detached HEAD và unavailable/error.
- Không lộ remote URL nhạy cảm hoặc raw backend error/event.
- Memory UI đúng scope, có revision/checksum/stale/source và không trộn raw memory vào transcript.
- Playwright smoke pass cho chat, agent management và memory drawer.
- Có unit/API/responsive/accessibility verification và bằng chứng không mất state khi đổi breakpoint.

## 11. Thứ tự triển khai bắt buộc

`Phase 0 canonicalization` → `Phase 1 shared foundations` → `Phase 2 desktop/chat` → `Phase 3 responsive/agents` → `Phase 4 memory contract` → `Phase 5 verification` → `Phase 6 cleanup`.

Không bắt đầu cleanup hoặc viết Playwright final suite trước khi canonical owner và shared contracts được chốt.
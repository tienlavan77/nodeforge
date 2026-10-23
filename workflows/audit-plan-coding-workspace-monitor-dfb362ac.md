<!-- Audit của plan PLAN-PROJECT-NODEFORGE-dfb362ac (Coding Workspace Monitor): đối chiếu evidence và các outcome O1-O5 với trạng thái repo hiện tại, ghi nhận plan đã lỗi thời so với code đã triển khai. -->

# Báo cáo audit — PLAN-PROJECT-NODEFORGE-dfb362ac (Coding Workspace Monitor)

**Đối tượng audit:** plan runtime `PLAN-PROJECT-NODEFORGE-dfb362ac-c038-4fb5-81a0-cdb654e16c9d`
**Tóm tắt nguồn liên quan:** `workflows/SUMMARY-9e328f41-7b62-4d8a-a905-63c12fb047de.md` (phần Assumptions / Unverified area)
**Tài liệu tham chiếu (rulebook):** `workflows/agents/architecture/README.md`
**Index repo đã dùng:** IDX-45326 (fresh)
**Ngày audit:** 2026-10-14

## Tổng quan

Plan **tuân thủ đúng khung vai trò/format**: các mục 3→7 khớp mẫu trong README, tôn trọng đầy đủ ba quyết định của owner (REOPEN_NEXT_RUN / LOCAL_BROWSER / PRESENCE_ONLY), tách guardrails/dependencies bắt buộc khỏi các gợi ý delivery, và không áp đặt số/tên ticket hay manifest file mutable cố định.

**Tuy nhiên phần evidence và mô tả "hiện trạng" đã lỗi thời.** Repository **đã triển khai và đã có test cho cả outcome O1–O5**. Plan mô tả trạng thái *trước* khi triển khai, còn code hiện ở trạng thái *sau* khi triển khai.

## 1. Evidence không còn khớp thực tế (stale)

Mọi sha256 / số dòng / chú thích "chưa có" trong mục 4 đều lệch so với file hiện đọc:

| Thành phần | Plan ghi | Repo hiện tại | Hệ quả |
| --- | --- | --- | --- |
| `coding-agent-panel-registry.js` | 75 dòng, sha `07d7a4a1…`, "without persistence / closed-panel policy" | **106 dòng, sha `981e110e…`** — đã có `runs{version,correlations,started}` + `closed[key]` + REOPEN_NEXT_RUN | O3 **đã triển khai** |
| `coding-workspace-monitor.jsx` | 40 dòng, sha `d33df9f0…`, "chưa có nút đóng / header ghim / Git Status" | **44 dòng, sha `c3752684…`** — có `<GitStatusIndicator client projectId>`, header `coding-workspace-column-header`, nút Close, `panels.map` theo `panel.key` | O1+O2 **đã triển khai** |
| `workspace-monitors.css` | 73 dòng, sha `75f7f368…`, "chưa sticky trong coding" | **82 dòng, sha `2d5cc616…`** — `.coding-workspace-column-header{position:sticky;top:0}`, `container-type`, `@container 490px→2` / `740px→3`, giữ `minmax(0,1fr) minmax(260px,2fr)` + `@media 760px→1fr` | O1+O5 **đã triển khai** |
| `coding/page.jsx` | sha `5021d2c7…` | sha `e0b4323a…` — đã wire `createCodingAgentPanelStatePersister`, `hydrateCodingAgentPanelRegistry`, `readCodingAgentPanelMembership`, `releaseRestoredPanelClosures` | O4 **đã triển khai** |
| `coding-workspace-layout.test.js` | sha `8212bd1b…`, "hồi quy hiện tại (phải mở rộng)" | **sha `c1394d33…`, đã mở rộng** — assert sticky header, props git indicator, `repeat(2,…)@490 / repeat(3,…)@740`, `doesNotMatch repeat([4-9])` | Acceptance O1+O5 **đã là test pass** |

Plan còn tham chiếu `WorkspaceMonitorPanels.jsx` (134 dòng) như "khuôn persistence" và **không hề nhắc tới `coding-agent-panel-state.js` (210 dòng)** — trong khi persistence LOCAL_BROWSER + PRESENCE_ONLY đã được tách thành module riêng này (`createCodingAgentPanelStatePersister` với debounce/`write`/`schedule`/`flush`; `serialize/read...Membership` chỉ lưu cặp `(projectId,agentId)`), kèm **hai test mới** `coding-agent-panel-state.test.js` và `coding-agent-panel-presence-restore.test.js`. Danh sách candidate-file vì vậy thiếu đúng những file trung tâm của đợt triển khai này.

## 2. Kiểm tra từng outcome (O1–O5)

- **O1 (sticky header + Git Status):** ĐẠT — CSS `position:sticky` trên `.coding-workspace-column-header`, Git indicator `margin-left:auto`, component render trong cột cuộn độc lập, test đã assert props `client` / `projectId=PROJECT_ID`.
- **O2 (mỗi agent một panel, cô lập identity):** ĐẠT — `codingAgentPanelKey` + `codingAgentProfile` (unique guard) + `codingAgentPanelActions` lọc theo `activityKey` đúng project+agent.
- **O3 (REOPEN_NEXT_RUN):** ĐẠT — `closeCodingAgentPanel` ghi `closed[key]=runs[key].version`; `update...` chỉ xóa `closed` khi phát hiện run **mới** (correlation_id mới, hoặc `started` mới khi không có correlation). Nhánh "marker thiếu → giữ nguyên trạng thái đóng" được encode bằng `previous` / `newRun=false`. Có test trong `coding-agent-panel-state.test.js` (`applyCodingAgentPanelRunPolicy`).
- **O4 (persist thiết bị-local + restore):** ĐẠT — module `coding-agent-panel-state.js` chỉ persist membership `(projectId,agentId)`, debounce, try/catch; **không** lưu summary/tool/status/scroll → khớp PRESENCE_ONLY. Có wiring `hydrate...` + `releaseRestoredPanelClosures` trong page.
- **O5 (lưới ≤3 cột + cuộn dọc + header ghim):** ĐẠT — `@container` 1/2/3 cột, cột `overflow-y:auto`, `doesNotMatch repeat([4-9])`, giữ nguyên top-level 2 cột + `@media 760px→1fr`.

## 3. Vấn đề còn lại trong chính plan (không phải code)

1. **Giả định responsive (mục 6) đã được resolve thành con số cụ thể** (container-query 490px→2, 740px→3; media breakpoint 640/760). Plan vẫn ghi "SL tự quyết breakpoint" — đúng thẩm quyền, nhưng evidence nên cập nhật để SL sau không phải đoán lại.
2. **Một comment trong source giờ hơi lệch semantics:** dòng 34 `coding-agent-panel-registry.js` vẫn nói "without implementing … closed-panel policy" trong khi `closed`/`runs` đã tồn tại. Đây là nit trong source (không phải plan), chỉ đáng ghi nhận vì plan dựa trên comment đó làm evidence.
3. **Unverified area — reconnect × REOPEN_NEXT_RUN:** plan tự đánh dấu cần xác minh; `coding-agent-panel-presence-restore.test.js` import cả `setCodingAgentPanelSource`, nên nhiều khả năng đã phủ, nhưng assertion cụ thể **chưa** được xác minh trong audit này.

## 4. Khuyến nghị

Plan **không còn là plan để triển khai O1–O5** — các outcome đã nằm trong source + test. Ba lựa chọn cho owner:

- **(a)** Đóng hồ sơ plan này là đã-delivered/superseded; khỏi lập SP cho O1–O5 (tránh re-implement).
- **(b)** Revisi evidence (sha256 / số dòng / "chưa có" → "đã có", thêm `coding-agent-panel-state.js` + hai test vào mục 4), rồi chỉ giữ phần **còn mở**: xác minh reconnect (mục 6), browser fixture verification (`browser-coding-fixture.js`), và mọi gap UX ngoài O1–O5.
- **(c)** Nếu chủ đích là một **đợt mới** mở rộng trên nền đã có, thì plan hiện tại chưa mô tả outcome mới nào — cần viết lại scope.

## 5. Trạng thái acceptance criteria (theo audit)

- [x] Mục tiêu, in/out scope, outcomes nhất quán với requirement đã chốt.
- [x] Facts đặc thù repository mang [Evidence]/[Source] tới các file đã đọc; assumptions và unverified area được đánh dấu rõ — **nhưng evidence đã stale so với trạng thái repo hiện tại (xem §1).**
- [x] Guardrails/dependencies bắt buộc tách khỏi gợi ý delivery.
- [x] Outcomes O1–O5 có tiêu chí kiểm tra được — **cả năm đã đạt trong source + test.**
- [x] Không áp đặt số/tên ticket hay manifest file mutable cố định.
- [x] Ba quyết định owner (REOPEN_NEXT_RUN / LOCAL_BROWSER / PRESENCE_ONLY) đã áp dụng đầy đủ — không hỏi lại, không đổi thành điều kiện chờ duyệt.
- [ ] Vẫn cần human approve đúng identity/revision/SHA-256 theo contract hiệu lực trước khi SL lập SP; SP không tự RUN/dispatch.

## Open items cần owner quyết

- ~~Chọn phương án (a)/(b)/(c) cho plan này.~~ **ĐÃ QUYẾT (owner, 2026-10-14): chọn (a)** — đóng hồ sơ plan `PLAN-PROJECT-NODEFORGE-dfb362ac` là đã-delivered/superseded; không lập SP cho O1–O5 (tránh re-implement).
- Xác nhận assertion reconnect × REOPEN_NEXT_RUN trong `coding-agent-panel-presence-restore.test.js`.
- Có làm mới comment lệch semantics tại `coding-agent-panel-registry.js` dòng 34 hay không.

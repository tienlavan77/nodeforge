<!-- Đề xuất riêng cho tạm dừng/tiếp tục chat Architecture Manager; không mở rộng quyền thực thi của plan System Engineer r2. -->
# Plan: Tạm dừng và tiếp tục chat Architecture Manager

> **Trạng thái:** đề xuất architecture mới, chưa được duyệt. Không thay đổi identity, revision hoặc SHA của `workflows/plan-pause-resume-r2.md`; tài liệu đó chỉ áp dụng cho direct `system_engineer`.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** owner không thể dùng controls tạm dừng/phục hồi của System Engineer cho chat `architecture_manager`. Một lượt architecture dài cần có cách dừng có chủ ý và biết rõ trạng thái sau khi reload/process chết, thay vì coi nút Retry của message là resume an toàn.
- **Kết quả:** trong đúng conversation Architecture, owner có thể tạm dừng lượt đang chạy và chọn tiếp tục hoặc bắt đầu attempt mới có chủ ý; không tự chạy lại thao tác ghi tài liệu hoặc làm mất evidence khi provider thread mất.
- **Giá trị:** kiểm soát chat Architecture mà vẫn giữ approval, scope ghi tài liệu và handoff cho SL độc lập.

## 2. Phạm vi

### In scope

- Checkpoint bền vững cho lượt owner chat `architecture_manager`, với lineage, trạng thái, summary có giới hạn và các tool boundary/receipt có khả năng ghi.
- Control API và UI trong workspace Architecture để Pause, Continue, Restart hoặc Discard một lượt dở, hiển thị trạng thái và lý do bị chặn sau reload.
- Quyền owner trong cùng project/conversation/agent; verification trước khi tiếp tục sau write hoặc provider interruption; thử nghiệm crash/race, UI và authorization.

### Out of scope

- Dùng chung recovery record hoặc endpoint System Engineer mà không có role-specific authority; mở quyền Git, `run_check`, chỉnh source hay dispatch cho Architecture.
- Tự động Continue, tự approve plan/Sprint Plan, thay đổi revision/hash approval hoặc xóa evidence chưa được reconcile.
- Áp dụng receipt remote push của r2 cho Architecture khi role này không có quyền push.

## 3. Hướng tiếp cận và guardrails

- **Boundary role:** chỉ thao tác trong allowlist Architecture (`ARCHITECTURE.md`, `docs/`, `Skills/`, `workflows/`); ghi tài liệu qua Forge File Service với checksum, không biến Pause thành quyền triển khai. Read-only tools có thể được thử lại; write/edit/delete đã bắt đầu nhưng chưa có receipt phải giữ `manual_required` cho đến khi Node kiểm tra state thật.
- **Quyết định rõ ràng:** Pause chỉ chặn tool boundary tiếp theo và yêu cầu hủy provider nếu có thể; không hứa hủy side effect đang chạy. Continue/Restart chỉ sau owner click/decision đã xác thực; Restart dùng provider context mới + structured summary từ checkpoint, không tự lặp tool đã hoàn tất. Discard giữ audit record.
- **Bất biến governance:** pause/restart không đổi plan identity, revision, SHA hoặc trạng thái approval; nội dung plan thay đổi vẫn cần approval mới theo contract hiệu lực. Không xem provider transcript là bằng chứng ghi file.
- **Lease/race:** chỉ một attempt có quyền thao tác trong conversation; nếu lease hết khi write còn active, giữ `manual_required` cho tới khi xác nhận process cũ đã dừng và file state được verify. Không tự cleanup pending/unknown/manual records.
- **Dependency thật sự:** xác định đường lưu/checkpoint và kiểm soát quyền owner có thể dùng chung primitives với System Engineer nhưng tách role policy. SL quyết định adapter, DAG, ticket và mutable-file manifest sau khi plan được duyệt; không suy đoán rằng reuse checkpoint hiện có là an toàn.
- **Quyết định UX đã chốt bởi owner:** hỗ trợ **cả Esc hai lần lẫn nút Pause riêng** trong workspace Architecture; cả hai gửi cùng lệnh Pause cho đúng lượt/conversation đang active và đi qua cùng authorization/checkpoint gate. Esc lần đầu chỉ hiển thị hint, lần thứ hai trong cửa sổ ngắn mới gửi lệnh; bỏ qua IME composition, phím giữ lặp, lượt không active và phím Escape thuộc dialog/rename đang mở. Nút Pause hiển thị rõ và không cần Esc; trạng thái đang gửi/đã pause phải tránh gửi lệnh trùng. Không đổi backend safety gates theo cách kích hoạt.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Khu vực | Evidence khảo sát / nhận xét |
| --- | --- |
| `workflows/plan-pause-resume-r2.md` và `workflows/plan-pause-resume-direct-engineer.md` | R2 chỉ ghi direct `system_engineer`; plan cũ loại Architecture khỏi scope. |
| `backend/src/application/owner-sdk-stream.js` | Nhánh SDK nhận cả hai role, nhưng `controller` và `executionCheckpoint.start` chỉ tạo khi role là `system_engineer` (dòng 29–43); checkpoint tool wrapper cũng chỉ chạy nếu có checkpoint (dòng 64). |
| `backend/src/application/owner-execution-control.js`, `backend/src/transport/http/forge-v1-conversation-routes.js` | `locate()` bắt role `system_engineer` (control dòng 8–14); GET list gọi `checkpoint.inspect()` không qua `locate()` (control dòng 17–19); route có list/pause/continue/restart/discard (route dòng 12–20). Không reuse route mà thiếu authorization. |
| `ui/nextjs/components/system-execution-controls.jsx`, `ui/nextjs/app/page.jsx` | Control hiện thuộc System workspace; HomePage Architecture không import control đó. |
| `backend/src/tools/owner-role-tool-policy.js` và `backend/src/infrastructure/filesystem/file-service-role-policy.js` | Role tool/file policy phân biệt Architecture và System Engineer; SL phải kiểm chứng enforcement trong recovery path trước implementation. |

Candidate discovery, không phải danh sách file được phép sửa. SHA của source có thể thay đổi; SL đọc lại trước khi lập SP.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được |
| --- | --- | --- |
| A1 | Pause Architecture bằng cả nút và Esc x2, trạng thái bền vững | Owner dùng nút Pause riêng hoặc Esc hai lần trong cửa sổ ngắn để dừng đúng lượt Architecture đang active; cả hai đi qua cùng gate và không gửi trùng; Esc lần đầu chỉ hint, Esc trong IME/phím giữ lặp/dialog hoặc rename không pause; hết cửa sổ hoặc không active thì không pause. Sau reload/process restart vẫn thấy conversation, attempt, trạng thái và bước đã hoàn thành. |
| A2 | Phục hồi không replay write | Continue/Restart chỉ do owner quyết định; Restart tạo context mới kèm bounded structured summary; completed write không chạy lại; pending write/delete hoặc thiếu receipt chặn ở `manual_required`, server xác minh checksum/absence trước khi mở gate. |
| A3 | Chặn race và vượt quyền | Hai process không đồng thời ghi cùng conversation; process cũ đang ghi thì attempt mới bị chặn cho tới khi xác nhận dừng và file state được verify; GET/list/decide/reconcile không lộ record hoặc nhận lệnh từ actor khác project/conversation/agent; recovery không cấp Git/source/dispatch. |
| A4 | Bảo toàn governance và có bằng chứng | Test integration sau write, giữa write và receipt, provider thread mất, lease race, reload, auth âm tính và UI; plan approval vẫn ràng buộc exact identity/revision/SHA, Pause/Restart không tự approve/RUN. |

SL mapping từng criterion tới ticket và verification; plan này không phải approval, SP hay dispatch.

## 6. Rủi ro, giả định và câu hỏi mở

| Vấn đề | Mức | Cách xử lý |
| --- | --- | --- |
| Reuse nguyên checkpoint System Engineer sẽ kéo theo Git receipt/authority sai role | Blocker | Chỉ reuse primitive đã tách policy và chứng minh role isolation. |
| Write hoàn tất nhưng process chết trước receipt | Blocker | `manual_required`; server kiểm tra file/checksum, không tin owner xác nhận đơn thuần. |
| Retry message hiện tại bị nhầm là Continue | Major | UI phân biệt retry câu trả lời với recovery execution; không tự replay pending step. |
| Esc toàn cục có thể xung đột với dialog/rename hoặc IME | Major | UX cả hai đã chốt; SL kiểm chứng ưu tiên phím khi dialog/rename mở, composition và duplicate pause, không làm Esc x2 kích hoạt ngoài lượt Architecture active. |

## 7. Acceptance criteria của plan

- [ ] Quyết định UX đã chốt (Esc x2 và nút Pause riêng) được phản ánh trong A1 và được kiểm thử cho cùng backend gate; scope Architecture vẫn cần exact human approval theo identity/revision/SHA trước khi SL lập SP.
- [ ] A1–A4 có bằng chứng role-specific; không suy nghiệm thu từ r2 System Engineer.
- [ ] SL lập SP sau exact human approval của identity/revision/SHA tài liệu này; không tự RUN/dispatch.

<!-- Báo cáo triển khai discovery autonomy và giới hạn bằng chứng nghiệm thu. -->
# Báo cáo triển khai: Discovery autonomy cho Coder

Ngày ghi báo cáo: 2026-10-24.

Kế hoạch liên quan: [plan-coder-autonomy-behavior-verification.md](../plans/plan-coder-autonomy-behavior-verification.md).

## 1. Phạm vi và trạng thái

Owner đã duyệt cập nhật và triển khai trong hội thoại. Đợt sửa này thực hiện phần discovery autonomy của phụ lục: runtime discovery, hai prompt builder và regression tests liên quan. Không tuyên bố hoàn tất toàn bộ O1–O6 của kế hoạch chính hoặc đạt production acceptance.

Không sửa `blocker-recovery-contract.js`, report/recovery contract, quyền ghi hoặc ngoại lệ commit cho `needs_context`.

## 2. Thay đổi triển khai

### Runtime discovery

File: `backend/src/tools/exploration-state.js`.

- Bỏ hard-throw `EXPLORATION_TYPE_BUDGET_EXHAUSTED`, `EXPLORATION_PREEDIT_DEADLINE` và `TARGET_KNOWN_SKIP_CANDIDATES`.
- Chuyển per-type cap, pre-edit marker và explicit target thành guidance qua `discoveryNotice`.
- Giữ tổng discovery budget và điều kiện escalation một lần cho discovery productive.
- Giữ `EXPLORATION_STAGNANT` như loop guard.
- `discoveryNotice` tiếp tục trả `by_type`, `remaining`, `edit_must_start_by`, `target_read`, `suggested_next_action` và message tương ứng.
- `discoveryCount` tính remaining theo tổng budget, không clamp theo edit marker.
- Xóa helper không còn dùng `bumpTypeLimit`; bỏ tham số `options` không còn được sử dụng ở `assertDiscoveryBudget`. Caller JavaScript truyền thêm đối số không gây lỗi.

**Lưu ý về accounting:** các call thông thường vẫn tăng `discovery_count` và bộ đếm theo loại khi đi qua advisory marker. Riêng call kích hoạt escalation tiếp tục giữ semantics có sẵn: tăng limit rồi trả về mà không tăng bộ đếm. Vì vậy không diễn giải limit mở rộng thành số lần executor chạy tuyệt đối; thay đổi này không sửa accounting tại ranh giới escalation. Sau edit, discovery budget không còn chặn các lượt đọc phục vụ verification theo hành vi hiện hữu.

### Prompt Claude và Codex

File: `backend/src/modules/supervisor/nodeforge-task-prompts.js`.

- Đồng bộ budget discipline: Coder tự chọn cách discovery trong tổng budget, không bị buộc dừng chỉ bởi per-type cap hoặc edit marker.
- Ghi rõ productive discovery có thể nhận một bounded total-budget extension.
- README là recommended preparation; vị trí đọc trong chuỗi discovery là advisory.
- Ghi rõ prerequisite runtime độc lập: phải đọc rules thành công trước edit. Không bỏ `CODER_RULES_REQUIRED`.

### Kế hoạch

File: `workflows/plan-coder-autonomy-behavior-verification.md`.

Đã cập nhật trạng thái phụ lục theo approval trong hội thoại, phạm vi triển khai, giới hạn evidence và điều kiện chưa đủ cho rollout.

## 3. Regression tests

### Tests được cập nhật hoặc bổ sung

- `backend/tests/unit/coder-reviewer-capabilities.test.js`: thay assertion per-type hard gate ở O2 bằng kiểm tra tiếp tục discovery và notice advisory. Fixture đặt `allow_escalation: false` để kiểm tra trần tổng độc lập; giữ assertion `CODER_NEEDS_CONTEXT`.
- `backend/tests/unit/runtime-tool-governance.test.js`: thêm test qua `createRuntimeToolGovernance().dispatch`. Cả ba loại discovery vượt marker vẫn được thực thi; hết tổng budget hoặc resource ngoài allowlist vẫn bị chặn trước executor; reservation được giải phóng.
- `backend/tests/unit/implementation-autonomy.test.js`: thêm test phân biệt advisory discovery order và mandatory prerequisite trong cả hai prompt.

### Kết quả đã ghi nhận trong lượt triển khai

| Kiểm tra | Kết quả |
| --- | --- |
| `coder-reviewer-capabilities.test.js` | 6/6 pass |
| `runtime-tool-governance.test.js` | 14/14 pass |
| Hai suite trên | 20/20 pass |
| Test mới phân lớp advisory/prerequisite trong `implementation-autonomy.test.js` | Pass |
| Toàn file `implementation-autonomy.test.js` | 3 pass, 3 fail |
| Syntax check hai file source đã sửa | Pass |
| `git diff --check` | Pass |

Ba lỗi trong `implementation-autonomy.test.js` đã xuất hiện cả khi tạm tách thay đổi source để đối chiếu baseline: assertion immutable prompt cũ, assertion review history cũ và lỗi ENOENT khi test chạy từ `backend/` nhưng tìm rulebook tại `backend/workflows/agents/sprint-leader/README.md`. Không phải cả ba đều là lỗi thiếu rulebook.

Các lượt kiểm tra liên quan rộng hơn cũng còn lỗi: lượt 51 tests gồm capability/governance, blocker commit authorization, comment guidance và ticket resume ghi nhận 43 pass, 8 fail. Sáu lỗi thuộc prompt comment guidance, hai lỗi thuộc blocker commit authorization. Chưa đối chiếu baseline đầy đủ cho tám lỗi này; không kết luận chúng đã được giải quyết hoặc đều là lỗi có sẵn.

Báo cáo này lưu kết quả của lượt triển khai trước, không phải một lượt chạy test mới. Lượt lưu tài liệu không chạy lại tests vì không đổi source.

## 4. Guardrails và giới hạn bằng chứng

- Không đổi authorization, resource allowlist, manifest, mutable-file budget, contract/AC, verification, exact-revision evidence hoặc independent review.
- Không bỏ commit-before-report cho `pass`; không tự tạo ngoại lệ cho `needs_context`.
- Test mới trực tiếp chứng minh tổng budget và allowlist tại governance dispatch; không coi một test này là bằng chứng tái kiểm thử mọi guardrail kể trên.
- Production Coder path hiện không truyền per-type limits/edit marker cho Coder. Đây là thay đổi semantics của gate dùng chung, không phải tuyên bố đã tái hiện và sửa một blocker production Coder.
- Witness governance dùng executor double tại boundary dispatch, không phải một phiên agent production end-to-end.
- Chưa có witness agent thật, snapshot/version binding, rollback hoặc drain checkpoint còn quyền Resume. Chưa đủ bằng chứng cho cutover/rollout theo §3.3 của kế hoạch.

## 5. Trạng thái bàn giao

Code và regression tests đã được cập nhật trong worktree; kết quả và các khoảng trống được ghi rõ ở trên. Các thay đổi không liên quan được giữ nguyên. Chưa commit hoặc push vì owner chưa yêu cầu.

Không coi báo cáo này là Sprint approval, quyền RUN/dispatch hoặc production acceptance.

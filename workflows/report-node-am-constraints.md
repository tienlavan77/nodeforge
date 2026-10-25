<!-- Báo cáo thảo luận các ràng buộc Node áp lên architecture-manager trong blocker recovery, dựa trên source hiện tại; tài liệu này không phải plan được duyệt hoặc quyền RUN/dispatch. -->
# Node siết architecture-manager ở đâu — report thảo luận

- **Ngày:** 2026-10-24
- **Phạm vi:** điều tra ràng buộc `architecture-manager` (AM) trong `blocker-decision-authority.js`, `blocker-recovery-contract.js` và `blocker-authority-passages.js`.
- **Trạng thái:** ghi nhận thảo luận; chưa sửa runtime, chưa duyệt plan và chưa cấp RUN/dispatch.

## 1. Mục tiêu

Xác định Node có siết AM quá chặt không, tách riêng:

- điều nào là guardrail chính đáng để bảo vệ phân quyền;
- điều nào là ma sát metadata;
- điều nào là bẫy logic trong retry/escalation;
- điều nào chưa chứng minh vì thiếu trace runtime.

## 2. Phạm vi và out of scope

**In scope:** hợp đồng disposition của AM khi xử lý blocker; căn cứ source hiện hành.

**Out of scope:** không đổi contract, không mở quyền tool, không chạy provider, không sửa plan đã duyệt, không tự suy ra approval từ bản ghi này.

## 3. Kết luận

**Không nên kết luận chung rằng Node siết AM quá chặt ở mọi đường đi.** AM vẫn được quyền trả lời SL và quyết kỹ thuật trong cấu trúc đã duyệt. Ràng buộc `resolved` tại Architecture scope là đúng vì nó quyết định hợp đồng kiến trúc, không phải quyền tự approve.

**Có một điểm quá cứng được xác nhận:** `boundary_inflation_forbidden` dùng một attempt bị reject trước đó để chặn escalation về sau, nhưng nó chỉ nhìn sáu cờ trong response bị reject, không phân biệt reject vì lỗi không liên quan hay vì phán quyết nội dung đã được xác nhận.

**Có một điểm cần hiệu chỉnh:** `authority_quote` không còn là ma sát bắt buộc khi AM đã dùng `authority_reference` hợp lệ. Node đã resolve reference thành passage text trước khi đối chiếu.

## 4. Bằng chứng source

| Vấn đề | Source | Mức chắc chắn |
|---|---|---|
| AM phải grounding quyết định Architecture-bound | `backend/src/modules/supervisor/blocker-decision-authority.js:37-57` | Chắc: validator kiểm tra scope, identity, quote, six flags. |
| `authority_reference` có thể thay quote tự chép | `backend/src/modules/supervisor/blocker-authority-passages.js:16-39`, `backend/src/modules/supervisor/blocker-recovery-contract.js:51-52` | Chắc: reference được resolve sang passage text sau khi kiểm tra scope và rationale. |
| `owner_required` bị chặn nếu six flags all-false | `backend/src/modules/supervisor/blocker-decision-authority.js:61-81` | Chắc: `delegated_to_architecture` từ chối owner_required khi không chứng minh boundary mới. |
| Attempt reject trước đó có thể chặn escalation sau này | `backend/src/modules/supervisor/blocker-decision-authority.js:78, 84-93` | Chắc về code path: parse response rejected rồi chặn nếu từng all-false. |
| `sprint_required` vẫn là quyết định Architecture-bound | `backend/src/modules/supervisor/blocker-recovery-contract.js:46-54` | Chắc: phải `assertArchitectureDisposition` rồi mới trả guidance về SL. |
| Rulebook phân quyền cho AM quyết trong cấu trúc đã duyệt | `workflows/agents/architecture/README.md:37-40` | Chắc về tài liệu quy tắc. |

## 5. Ma sát còn lại

1. **Identity copy nguyên văn:** `plan_id`, `revision`, `sha256` phải đúng và chỉ được chứa ba khóa đó. Đây là guardrail chính đáng, nhưng dễ khiến retry nếu AM sao chép sai metadata.
2. **Six flags all-false:** hợp lệ khi AM không vượt boundary, nhưng nếu lần trước bị reject vì format/checksum, lần sau vẫn có thể bị chặn bật cờ true mặc dù đã có evidence mới.
3. **Thiếu ô an toàn cho owner note:** AM muốn ghi nhận rủi ro trong phạm vi nhưng không cần owner approve. `summary` và `guidance` có thể mô tả, nhưng chưa có chuẩn để gắn rủi ro vào bản ghi một cách có cấu trúc.

## 6. Đề xuất, chưa phê duyệt triển khai

1. **Rà soát `priorAllFalseAssessment`:** chỉ vô hiệu hóa flag inflation khi attempt trước bị reject vì **chính phán quyết nội dung**, không chặn vì format/checksum/metadata lỗi.
2. **Chưa thêm `resolved_with_note`:** chỉ cân nhắc nếu runtime trace chứng minh AM cần một ô cấu trúc riêng cho risk note; không mở schema chỉ vì tiện ghi chú.
3. **Giữ nguyên guardrail:** exact identity, six flags, không dispatch Coder, không đổi immutable contract, không bỏ Reviewer gate, không tự bịa owner approval.
4. **Cần trace trước khi quyết:** thống kê `disposition_attempts`/`validation_feedback` theo job AM, số attempt, số job phục hồi sau sửa metadata và số `boundary_inflation_forbidden` sau reject không liên quan.

## 7. Giả định, rủi ro và câu hỏi mở

- **Giả định:** response bị reject vẫn giữ `boundary_assessment` đủ để `priorAllFalseAssessment` parse được; cần kiểm chứng bằng test/log.
- **Rủi ro:** nới điều kiện có thể cho AM đổi cờ để né `delegated_to_architecture`; cần yêu cầu evidence mới và lý do thay đổi đánh giá khác biệt.
- **Câu hỏi mở:** có cần `resolved_with_note` hay `guidance` hiện tại đã đủ để chuyển rủi ro cho SL/owner? Cần trace để trả lời.
- **Ràng buộc:** bản ghi này chỉ là tài liệu; không tạo plan được duyệt và không cho phép RUN.

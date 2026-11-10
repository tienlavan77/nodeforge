# Review plan-source-r1 — PLAN-PROJECT-NODEFORGE

Ngày review: 2026-11-10

## Identity

- Plan: `PLAN-PROJECT-NODEFORGE-d69fa8ff-8eb9-4a57-9ddf-e5bdb2d497cd`
- Revision: `r1`
- Source path: `.forge/runtime/nf/plans/PLAN-PROJECT-NODEFORGE-d69fa8ff-8eb9-4a57-9ddf-e5bdb2d497cd/plan-source-r1.json`
- SHA-256 đã ghi nhận: `sha256:ad933cb3c11c681933d5e051c02fdecbe38c29264b0aaf9858500b741f412999`

## Kết luận kỹ thuật

### 1. Luồng DISCUSS ở vòng cuối phải luôn đi qua AM

Trước thay đổi, `startHandoff` trả `paused/CRITIQUE_CONSENSUS_REQUIRED` ngay sau khi SE trả `[CRITIQUE: DISCUSS]` ở vòng cuối (với handoff không phải lệnh Owner trực tiếp). Do đó AM không được nhận phản biện và không có cơ hội trả lời hoặc phát hành patch.

Đã sửa `backend/src/application/am-se-handoff-service.js` để:

1. gọi AM ở cả vòng cuối;
2. chạy `maybeApplyCritiqueRevision` sau phản hồi AM;
3. cập nhật metadata `plan_revision`, `plan_sha256`, `plan_source_path` của record;
4. chỉ sau đó mới pause với `CRITIQUE_CONSENSUS_REQUIRED` nếu vẫn là handoff không explicit Owner.

Kết quả giữ đúng nguyên tắc fail-closed: DISCUSS cuối vòng không tự động được xem là ALIGNED và không tự động chạy implementation.

### 2. Patch của AM vẫn cập nhật trực tiếp draft r1

`applyCritiqueDraftRevision` chỉ chấp nhận patch khi revision hiện tại là `1`, gọi `updateDraftRevision`, giữ audit snapshot và ghi lại source r1. Không có bằng chứng cho việc tạo r2 trong đường này; revision trả về vẫn là `1`.

### 3. Sửa wiring checkpoint cần thiết cho luồng handoff

Trong cùng service, critique checkpoint trước đây thiếu `projectId`, `fileService` và `gitService`. Guard khởi tạo vì thế có thể trả `HANDOFF_CRITIQUE_INVALID` ngay cả với record mới hợp lệ. Đã truyền các dependency này vào `createAmSeCritiqueCheckpoint`, để kiểm tra project identity và workspace snapshot hoạt động đúng.

## Kiểm tra

Đã chạy:

```text
node --test backend/tests/unit/am-se-handoff-service-resume.test.js backend/tests/unit/conversation-plan-handoff.test.js
```

Kết quả: **PASS** (`VERIFY-RUN-789032f5-d6ad-42a2-9fbe-dace6f76f5f2`).

Các test này xác nhận luồng resume/handoff hiện có và việc critique DISCUSS → patch r1 → ALIGNED. Chúng chưa phải fixture riêng chứng minh toàn bộ nhánh **DISCUSS ở vòng cuối**; không nên diễn giải kết quả test như bằng chứng runtime production end-to-end cho nhánh đó.

## Hạn chế khi review source plan

Tại thời điểm viết báo cáo, Node File Service trả `ENOENT` khi truy cập thư mục runtime chứa `plan-source-r1.json`; vì vậy không thể đọc lại nội dung JSON đầy đủ trong phiên này. Báo cáo dựa trên plan identity/checksum đã được Forge ghi nhận trước đó và trên source code/checks đã trực tiếp kiểm tra. Cần đọc lại đúng file r1 trong một phiên có runtime path tồn tại trước khi kết luận về nội dung nghiệp vụ chi tiết của từng outcome, guardrail hoặc acceptance criterion.

## File thay đổi

- `backend/src/application/am-se-handoff-service.js`
- `docs/architecture/plan-source-r1-review.md`

Các thay đổi khác đang có trong working tree là thay đổi tồn tại trước/ngoài phạm vi này và không được đưa vào báo cáo như một phần của patch trên.

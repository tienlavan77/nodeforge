# Báo cáo luồng AM ↔ SE ↔ RV và checkpoint plan

Tài liệu này ghi nhận cấu trúc điều phối hiện tại, nguyên nhân resume bị kẹt sau khi API dừng, và mô hình checkpoint thống nhất cần áp dụng cho một plan run.

## 1. Luồng hiện tại

Một handoff được tạo với mã:

`HANDOFF-${plan_id}-R${revision}`

Handoff lưu các định danh chính:

- `plan_id`
- `plan_revision`
- `plan_sha256`
- conversation của AM, SE và RV
- agent ID của AM, SE và RV
- phase hiện tại
- round hiện tại
- workspace scope và workspace snapshot
- approval owner

### Giai đoạn phản biện kế hoạch

Luồng phản biện hiện tại là:

```text
SE đọc và phản biện kế hoạch
  ├─ ALIGNED → kết thúc phản biện
  └─ DISCUSS → AM trả lời/chỉnh kế hoạch → SE phản biện lại
```

Mỗi lượt SE hoặc AM được ghi vào `critique_checkpoint` trước khi chuyển lượt kế tiếp. Kết quả phản biện chỉ được xem là hoàn tất khi có kết quả hợp lệ, terminal receipt và trạng thái `completed`.

### Approval

Sau khi phản biện hoàn tất, hệ thống kiểm tra:

- đúng Owner đã phê duyệt;
- đúng revision;
- đúng SHA của kế hoạch;
- kế hoạch không bị thay thế bởi revision khác.

Nếu không khớp, handoff phải dừng và không được tự chạy SE.

### Giai đoạn thực thi

Sau approval, implementation chạy theo thứ tự:

```text
SE code → RV review → AM acceptance
```

- SE thực thi kế hoạch và trả bằng chứng code/test.
- RV review độc lập kết quả của SE.
- RV trả verdict `PASS` hoặc `REVISE`.
- Với `REVISE`, round kế tiếp gửi finding của RV cho SE.
- AM chỉ nghiệm thu sau khi có kết quả RV hợp lệ.

## 2. Vấn đề thiết kế hiện tại

Hiện tại một plan run dùng hai vùng checkpoint độc lập:

- `critique_checkpoint` cho AM ↔ SE;
- `checkpoint` cho SE → RV → AM.

Việc tách này sai ở cấp execution lineage. Hai vùng vẫn thuộc cùng một handoff nhưng có generation, current step, execution ID, workspace snapshot và trạng thái riêng. Khi API dừng giữa hai phase, resume có thể đọc sai checkpoint hoặc không biết phase trước đã hoàn tất.

Các lỗi có thể phát sinh:

- `HANDOFF_CRITIQUE_STALE`;
- `HANDOFF_CRITIQUE_RECOVERY_REQUIRED`;
- `reconciliation_required`;
- mất liên kết giữa kết quả critique và implementation;
- không hiện Resume trên UI dù conversation vẫn còn dữ liệu;
- gọi lại sai role hoặc lặp lại một mutation đã hoàn tất.

## 3. Mô hình cần thống nhất

Một plan run phải có **một execution lineage và một checkpoint gốc**. Các phase chỉ là trạng thái con của checkpoint đó.

Đề xuất cấu trúc:

```text
handoff_checkpoint
├── phase: plan_critique | implementation | completed
├── round
├── current_step
├── next_step
├── execution_id
├── generation
├── plan_revision
├── plan_sha256
├── workspace_snapshot
├── receipt
├── approval
└── phase_results
    ├── critique: SE/AM
    └── implementation: SE/RV/AM
```

Checkpoint gốc phải giữ cùng một:

- `handoff_id`;
- `lineage_id`;
- `generation`;
- `plan_revision`;
- `plan_sha256`;
- workspace baseline;
- execution receipt;
- trạng thái role kế tiếp.

Dữ liệu critique và implementation có thể được nhóm theo phase để dễ đọc, nhưng không được tạo hai state machine resume độc lập.

## 4. Quy tắc khôi phục sau API crash

Khi API dừng, resume phải đọc checkpoint gốc và tiếp tục từ `next_step`:

```text
AM ↔ SE critique
→ approval
→ SE code
→ RV review
→ AM acceptance
```

Quy tắc kiểm tra:

1. Receipt đã completed, runner đã dừng, không còn pending tool call và workspace không đổi: nhận lại kết quả, không gọi agent lần hai.
2. Không có mutation và workspace không đổi: retry đúng role và đúng execution lineage.
3. Receipt chưa xác định hoặc workspace đã đổi: ghi trạng thái cần khôi phục có kiểm soát, không tự chạy lại.
4. Không được tạo handoff mới cho cùng plan revision khi checkpoint cũ còn khả năng resume.
5. Không được dùng checkpoint critique để resume implementation hoặc ngược lại; cả hai phải truy cập cùng checkpoint gốc.

## 5. Điều kiện để UI hiển thị Resume

Projection của handoff phải lấy từ checkpoint gốc và trả về:

- phase;
- current step;
- next step;
- execution status;
- resume allowed;
- lý do bị pause/failure;
- plan revision và SHA;
- handoff ID.

UI không nên phụ thuộc việc có một conversation mới hay không. API crash chỉ là gián đoạn runner; trạng thái handoff phải vẫn đủ để hiển thị Resume sau khi API khởi động lại.

## 6. Kết luận

Luồng AM ↔ SE ↔ RV là một plan run duy nhất. Critique và implementation là hai phase của cùng một state machine, không phải hai execution độc lập. Cần hợp nhất checkpoint ở cấp handoff, giữ phase results riêng bên trong, và dùng một lineage duy nhất cho mọi lần resume. Đây là điều kiện để khôi phục sau API crash mà không phát sinh stale checkpoint, chạy lặp agent hoặc mất trạng thái nghiệm thu.

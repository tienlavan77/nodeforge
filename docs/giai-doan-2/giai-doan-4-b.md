## Giai đoạn 4 — Guard nặng, cần hạ tầng

> Ở Giai đoạn 1, `1-1` đã tạo branch và `1-5b` đã commit từng round (dùng 0c-3) — Giai đoạn này KHÔNG viết lại phần đó, chỉ bổ sung 2 việc còn thiếu: **merge/discard cuối cùng** (4a) và **verify thật trước khi merge** (4b). 2 nhóm này phụ thuộc lẫn nhau ở đúng 1 điểm: merge chỉ được gọi SAU KHI verify pass — runner hiện tại phải gọi verification gate sau khi code/wiring đã commit; không dùng `status_check` để thay thế verify.

### 4b — Verify tầng 1+2 (làm trước 4a vì 4a-4 phụ thuộc kết quả của 4b)

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 4b-1 | Bổ sung Git primitives: changed files, branch cleanup, lỗi merge phân loại | ✅ Đã làm | Git Service có `getChangedFiles({baseCommit, headCommit})`, `deleteMergedBranch()` và merge conflict rõ ràng. |
| 4b-2 | Verification tầng syntax/check | ✅ Hạ tầng đã có | Verification Orchestrator/Check Runner chạy các check được lập trong verification plan; chưa có parser riêng theo từng đuôi `.php`/`.scss`. |
| 4b-3 | Verification build/lint/typecheck | ✅ Đã làm | `buildVerificationPlan()` chọn lệnh theo scope; kết quả có exit code, stdout/stderr và diagnostics. |
| 4b-4 | `runVerification(task_id)` — gộp các check | ✅ Đã làm | `verificationOrchestrator.run(plan)` là cổng duy nhất; trả kết quả aggregate `ready_for_review` và breakdown. |

### 4a — Git branch/rollback đầy đủ

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 4a-1 | `merge(branch, opts)` có phát hiện conflict | ✅ Đã làm | Git Service phân biệt `GIT_MERGE_CONFLICT` với lỗi merge khác và không tự resolve. |
| 4a-2 | Merge task branch vào base branch | ✅ Đã nối | Runner lưu `base_branch` khi khởi tạo và truyền rõ `target`, dùng `--no-ff`. |
| 4a-3 | Xử lý merge conflict | ✅ Đã làm | Chuyển `needs_human_review`, abort merge và báo roadmap; lỗi Git khác chuyển theo nhánh lỗi tương ứng. |
| 4a-4 | Cleanup task branch | ✅ Đã làm | Có `discardBranch()` cho rollback bắt buộc và `deleteMergedBranch()` dùng `git branch -d` sau merge. |
| 4a-5 | Nối verification gate vào Stage-1 runner | ✅ Đã làm | Sau code/wiring, runner verify commit cuối; fail retry có kiểm soát, pass merge vào `base_branch`, conflict chuyển `needs_human_review`, merge thành công xóa branch đã merge. |

### 4c — Verify tầng 3 (test hành vi)

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 4c | Verify hành vi thật (vd Puppeteer đo `scrollWidth` theo viewport) | ☐ Để sau | Chỉ làm nếu thực sự cần cho loại ticket UI/visual lặp lại nhiều — chưa đưa vào `runVerification` (4b-4) mặc định, chỉ chạy khi ticket có tag riêng (vd `responsive`). |

**Trạng thái triển khai:** Hạ tầng 4a/4b và wiring runtime đã được triển khai, các unit/integration test liên quan hiện pass. Còn thiếu test thật trên repository branch với build credentials/dependencies đầy đủ và worktree riêng cho chạy song song; 4c vẫn để sau.

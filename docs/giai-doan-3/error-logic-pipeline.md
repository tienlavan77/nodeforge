<!-- Báo cáo nguyên nhân gốc và phương án xử lý lỗi logic của pipeline ticket. -->

# Lỗi logic gốc của Ticket Pipeline

## Kết luận

Lỗi lớn nhất không nằm riêng trong một ticket. Pipeline hiện có nhiều nguồn sự thật khác nhau:

1. Agent ghi code vào project chính qua Forge.
2. Ledger ghi snapshot thay đổi.
3. Git commit nằm trong worktree.
4. Verification có thể chạy trên project chính.
5. Reviewer đọc source/cache project chính rồi đối chiếu với commit/worktree.

Vì vậy Coder có thể báo đã sửa và commit, verification lại kiểm tra source khác, còn Reviewer đọc trạng thái khác. Các lỗi như `TICKET_BASELINE_CONFLICT`, review lặp, evidence không khớp và `needs_human_review` là hậu quả của thiết kế này.

## Các lỗi logic gốc

### 1. Verification dùng sai root

`ticket-workspace-service.js` khởi tạo verification và test service bằng project root chính, trong khi commit và baseline của ticket nằm ở worktree. Verification vì vậy không chắc đang kiểm tra revision mà Reviewer sẽ duyệt.

### 2. Có hai nơi chứa source

Forge ghi vào project chính, Git service commit ở worktree, còn commit service phải reconcile nội dung từ ledger sang worktree. Cơ chế này gây conflict giả, file mới không được index, thay đổi mode file và lỗi baseline.

### 3. Evidence verification không bất biến

Evidence hiện chưa gắn đầy đủ với commit SHA, source revision, cwd, stdout/stderr đã redact, checksum file, artifact ID và thời gian chạy. Reviewer chủ yếu nhận summary và tool events nên không có bằng chứng tái lập độc lập.

### 4. Verification do changed paths chi phối

Bộ test được suy ra từ danh sách file agent báo đã thay đổi. UI test có thể không chạy nếu ticket không sửa test UI; agent cũng gián tiếp ảnh hưởng phạm vi kiểm tra qua `changed_paths`.

### 5. Reviewer chưa duyệt một revision bất biến

Reviewer đọc current source/cache cùng diff từ `base_commit`. Nếu source hoặc cache thay đổi sau commit, evidence có thể không còn thuộc commit đang review.

### 6. Review loop không có trạng thái cho từng finding

Finding chỉ được truyền lại dưới dạng chuỗi. Pipeline không biết finding nào đã sửa, file nào xử lý và evidence nào chứng minh. Coder và Reviewer vì thế có thể lặp cùng một vòng cho tới giới hạn revision.

### 7. Ticket vẫn có lỗi source riêng

Commit `3be2023bd399bb1bc5f40b14923f4452d93c1d18` còn các vấn đề cụ thể: regex redaction sai escape, hai error contract song song (`retryable` và `recoverable`), thiếu evidence test/build đầy đủ và chưa chứng minh boundary thực dùng `normalizeAgentError`. Đây là lỗi của ticket, nhưng không phải nguyên nhân duy nhất của vòng lặp pipeline.

## Các phương án

### Phương án A: sửa tối thiểu

Giữ worktree và ledger hiện tại, sửa verification dùng đúng worktree, bổ sung evidence stdout/stderr/checksum, chuẩn hóa error contract và thêm finding resolution.

Ưu điểm là ít thay đổi. Nhược điểm là vẫn giữ hai source và cơ chế reconcile phức tạp, nên nguy cơ conflict còn cao.

### Phương án B: một source có kiểm soát — khuyến nghị

Giữ worktree làm baseline và commit receipt; source duy nhất vẫn là project chính theo quy định mọi ghi file phải qua Forge.

```text
Supervisor tạo manifest
        ↓
Forge claim file
        ↓
Agent sửa project chính qua Forge
        ↓
Watcher/indexer cập nhật source chính
        ↓
Verification chạy trên source chính và manifest revision
        ↓
Supervisor tạo commit receipt từ ledger snapshot
        ↓
Reviewer duyệt commit SHA và evidence bất biến
```

Commit service phải tạo commit từ snapshot cuối của ledger, không replay tùy ý các patch cũ.

### Phương án C: cô lập hoàn toàn bằng worktree

Agent, Forge, verification và Reviewer đều chạy trong worktree; chỉ merge vào project chính sau khi accepted. Phương án này phù hợp Git isolation nhưng trái với quy định hiện tại về Forge, source chính và watcher nên không chọn.

## Kiến trúc cần chốt

### Ticket Execution Context

Tạo một context duy nhất và truyền xuyên suốt Forge, verification, commit và review:

```text
task_id
project_id
base_sha
source_revision
manifest_paths
manifest_sha
verification_artifact_id
review_commit_sha
```

Không để từng service tự suy ra root hoặc commit.

### Durable Verification Artifact

Mỗi lần chạy test phải lưu artifact bất biến gồm:

```text
artifact_id
task_id
commit_sha
source_revision
cwd
commands
stdout_redacted
stderr_redacted
exit_code
duration_ms
file_checksums
status
```

`report_done` chỉ hợp lệ khi artifact đã pass và khớp revision hiện tại.

### Immutable Review Contract

Reviewer chỉ được approve khi:

```text
review.commit_sha === verification.commit_sha
review.source_checksums === verification.source_checksums
review.base_sha === ticket.base_sha
```

`coder_summary` không được xem là bằng chứng chính.

### Finding Resolution State Machine

Mỗi finding phải có:

```text
finding_id
status: fixed | not_fixed | not_applicable
changed_paths
evidence_refs
resolved_revision
```

Revision tiếp theo chỉ gửi các finding chưa có bằng chứng hợp lệ.

## Thứ tự triển khai

1. Tạo `TicketExecutionContext`.
2. Cho Forge, verification, commit và Reviewer dùng chung context.
3. Từ chối verification khi source revision không khớp.
4. Tạo durable verification artifact.
5. Chuyển commit service sang snapshot ledger cuối, không replay patch.
6. Chuẩn hóa error contract thành `{ code, message, retryable, scope, requestId }`.
7. Thêm `finding_resolution` và gate kiểm tra từng finding.
8. Sửa lỗi source cụ thể của `NF-UI-CONV-003`.
9. Chạy E2E hai ticket cạnh tranh cùng file, restart, resume, review revision và watcher update.

Không nên tiếp tục vá riêng ticket `TICKET-PROJECT-NODEFORGE-1790660105591` trước khi hoàn tất lớp context và evidence của pipeline.

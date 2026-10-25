# Kế hoạch: phục hồi ticket mà không siết quá Coder

**Ngày:** 2026-10-24 (UTC)
**Trạng thái:** Phân tích đã đối chiếu source; chưa triển khai code.
**Phạm vi:** Đánh giá ticket recovery/commit/report/verification/review ở tầng Node/Forge, với mục tiêu giữ cho agent làm việc theo flow bình thường và để Node tự đối soát, tự phục hồi khi có đủ bằng chứng.

## 1. Kết luận ngắn

Không nên dựng thêm một state machine quản trị mới, không nên bắt Coder khai báo recovery mode, commit identity hoặc ledger revision, và không nên biến mọi bất nhất nội bộ thành human review.

Code hiện tại đã có phần lớn cơ chế cần thiết:

- durable ticket change ledger và path claims;
- write idempotency, pending-write recovery và source-drift detection;
- root commit transaction journal, commit-tree/branch/receipt recovery;
- execution-context versioning, cross-process locking và fencing;
- verification wait/recovery;
- immutable review identity và retry trên cùng source/artifact;
- Coder report recovery;
- phân loại operational/transient/reconcile/repair/authority failures;
- owner/human review và blocker recovery.

Vì vậy hướng đúng là **sửa các điểm nối và lỗi thật sự**, không bổ sung thêm thủ tục cho agent.

## 2. Những cơ chế đã tồn tại trong source

### 2.1. Ticket source và commit

- `backend/src/modules/supervisor/ticket-change-ledger.js`
  - ghi manifest theo ticket;
  - giữ `revision`, `entries`, `commits`, `pending_commit`;
  - dùng lock theo ticket/path;
  - chống lặp bằng `operationId`;
  - phục hồi write dở dang qua `recover()`;
  - phát hiện `TICKET_SOURCE_DRIFT`/`TICKET_SOURCE_CHANGED`;
  - transaction commit qua `withCommitTransaction()`.
- `backend/src/modules/supervisor/ticket-root-commit-service.js`
  - chuẩn bị transaction;
  - kiểm tra source/branch/tree/parent;
  - ưu tiên restore/reconcile trước khi tạo commit mới;
  - có `reconcileNoRefMove` và `reconcileRestoredCommit`.
- `backend/src/modules/supervisor/ticket-restored-commit.js`
  - kiểm tra transaction receipt, parent SHA, tree SHA, transaction trailer, changed paths và path checksums;
  - kiểm tra lại live source trước khi tái liên kết commit.

### 2.2. Execution context và checkpoint

- `backend/src/modules/supervisor/ticket-execution-context.js`
  - lưu `source_revision`, `manifest_sha`, `review_commit_sha`, `verification_artifact_id`;
  - kiểm tra version bằng compare-and-swap;
  - khóa cross-process;
  - đóng băng context terminal/integrating;
  - kiểm tra baseline scope và mutable file budget.
- `backend/src/modules/supervisor/ticket-resume.js`
  - giữ session/thread, turn history, changed paths, read cache và verification wait;
  - phục hồi prompt mà không lặp mutation đã hoàn tất.
- `backend/src/modules/supervisor/ticket-checkpoint-writer.js`
  - checkpoint best-effort; lỗi lưu checkpoint không làm hỏng tool result.

### 2.3. Verification, review và report

- `backend/src/modules/supervisor/ticket-report-verification-wait.js`
  - giữ report draft;
  - chờ verification trong Node;
  - trả evidence về cùng Coder session;
  - không đánh dấu completed sớm.
- `backend/src/modules/supervisor/ticket-verification-recovery.js`
  - khôi phục verification trên committed context;
  - bounded retry;
  - giữ source commit và failure diagnostic.
- `backend/src/modules/supervisor/automatic-review-identity.js`
  - gắn review với source revision, commit, artifact, base, manifest, policy, contract và checksums;
  - chống áp dụng review vào source khác.
- `backend/src/modules/supervisor/review-operational-retry.js`
  - retry lỗi kết nối trên cùng commit/artifact;
  - kiểm tra ownership, ticket state và execution context trước retry.
- `backend/src/modules/supervisor/coder-report-recovery.js`
  - khôi phục report từ immutable verified evidence;
  - không edit, recommit hoặc chạy lại verification khi evidence còn khớp.

### 2.4. Phân loại lỗi và quyền quyết định

- `backend/src/modules/supervisor/coder-failure-routing.js`
  - đã phân biệt `transient`, `reconcile`, `authority`, `repair`, `reviewer`, `terminal`.
- `backend/src/modules/supervisor/coder-operational-recovery.js`
  - bounded retry durable;
  - deduplicate theo parent request;
  - có execution validation/fencing;
  - không reclaim invocation đang ở trạng thái `invoking`;
  - có deadline, cancellation và resume.
- `backend/src/application/ticket-human-review-service.js` và nhóm `blocker-*`
  - đã có owner decision, blocker evidence, approval retry, technical reconciliation và human review.

**Kết luận:** các phần trên không nên được xây lại dưới tên mới hoặc nhân thêm gate tương đương.

## 3. Sai lệch trong nhận định trước đây cần loại bỏ

### 3.1. Không thể coi mọi SHA khác nhau là conflict

Ticket có thể có nhiều commit hợp lệ. `6ac05740...` là commit con của `fd5211f4...`; dữ kiện này chưa đủ để kết luận replacement trái phép. Cần phân biệt:

- commit follow-up hợp lệ;
- commit được tạo sau source edit hợp lệ;
- transaction retry tạo commit mới ngoài ý định;
- association/recovery revision;
- thay đổi ngoài ticket.

### 3.2. Không nên tạo thêm một kho canonical độc lập

`TicketCommitIdentity` chỉ nên là mô hình định danh/đối soát nếu cần, không phải một ledger thứ hai. Quyền quyết định phải được xác định giữa ledger, transaction journal và execution context; projection có thể dựng lại khi đủ bằng chứng.

### 3.3. Không nên ép tất cả ticket vào một chuỗi lifecycle cứng

Phải giữ được các loại ticket:

- chỉ điều tra;
- no-op;
- nhiều commit;
- nhiều vòng review/repair;
- bị cancel/supersede;
- verification hoặc report retry.

Agent vẫn dùng flow bình thường: đọc, sửa, kiểm tra, commit khi có thay đổi, report và xử lý finding. Node chịu trách nhiệm bookkeeping/recovery.

## 4. Quan sát cụ thể từ manifest ticket READ-WINDOW-SL

Manifest ticket có 17 paths, đang ở revision 63, với:

- revision 55 → `fd5211f4...`;
- revision 63 → `6ac05740...`.

Danh sách operation cho thấy nhiều revision có `before_sha === after_sha`, ví dụ các revision 41, 43, 45, 47, 49, 51, 53, 55, 63. Đây là dấu hiệu revision churn do no-op write.

Tuy nhiên không được suy ra chỉ từ đó rằng toàn bộ revision 56–63 là no-op; cần phân biệt các operation thật sự có nội dung thay đổi với operation lặp. Vì vậy đây là điểm cần kiểm chứng bằng test/diagnostic, không phải lý do để tự động rollback hoặc chọn một SHA.

Khả năng gây kẹt thực tế là sự kết hợp giữa:

1. revision tăng bởi write không đổi nội dung;
2. completion gate dùng thứ tự `completedTools` để suy luận commit còn thiếu;
3. report retry và commit retry không cùng nhìn một durable disposition;
4. source revision hiện tại đã khác revision của retained commit nên restore hợp lý trả `null`;
5. normal commit path sau đó có thể tạo commit follow-up.

## 5. Bản sửa tối thiểu cần điều tra trước khi code

### 5.1. No-op write

Kiểm tra contract hiện tại của `ticket-change-ledger.write()`:

- Nếu `before` và `after` cùng checksum, operation có thật sự cần tạo source revision mới không?
- Có caller nào dựa vào revision tăng dù nội dung không đổi không?
- Có cần trả kết quả `repeated/noop` mà không tăng revision không?

Nếu không có contract phụ thuộc, đây là ứng viên sửa nhỏ để giảm revision churn. Phải bổ sung test cho:

- no-op lần đầu;
- lặp cùng `operationId`;
- no-op sau source đã thay đổi;
- file mới/xóa file;
- pending write recovery.

Không được sửa chỉ dựa vào ticket này nếu chưa kiểm tra caller và backward compatibility.

### 5.2. Completion gate

`assertCommitBeforeReport()` trong `ticket-resume.js` hiện dùng vị trí cuối của `write_diff/edit_diff` và `commit_changes`, sau đó mới thử `tool.reconcileCommit()`.

Cần đánh giá thay thế tối thiểu:

- giữ tool history làm tín hiệu phụ;
- ưu tiên durable ledger/journal/source reconciliation;
- nếu durable state chứng minh commit hiện tại đã gắn đúng revision thì không bắt agent recommit;
- nếu source thật sự có revision chưa commit thì vẫn yêu cầu commit bình thường;
- nếu không thể phân biệt thì trả lỗi reconciliation cụ thể, không tạo thêm side effect tự động.

Mục tiêu là giảm false `COMMIT_MISSING`, không bỏ commit gate.

### 5.3. Commit retry

Không được đổi `commit_changes` thành một gate mới cho agent. Cần kiểm tra transaction service để bảo đảm:

- commit đã ghi receipt được trả lại idempotently;
- transaction đang pending được reconcile trước khi tạo commit mới;
- commit follow-up hợp lệ sau source edit không bị coi là conflict;
- retry không tạo commit mới khi source thực tế không đổi.

## 6. Nguyên tắc UX/agent sau khi sửa

Agent không cần biết:

- ledger revision;
- transaction ID;
- recovery mode;
- canonical identity;
- cách đồng bộ execution context.

Agent chỉ cần nhận hướng dẫn nghiệp vụ ngắn:

- tiếp tục bước còn thiếu;
- sửa finding;
- chạy check cần thiết;
- report lại.

Node chỉ chuyển sang owner/human review khi có quyết định nghiệp vụ hoặc mâu thuẫn bằng chứng không thể tự phân xử. Các lỗi như mất response, checkpoint chậm, context projection thiếu hoặc retry vận hành phải được tự reconcile khi có đủ bằng chứng.

## 7. Acceptance criteria cho governance fix

1. Không tạo thêm state machine hoặc tool bắt Coder khai báo recovery.
2. Không làm mất các gate scope, authorization, source protection và verification hiện có.
3. No-op retry không làm tăng source revision nếu contract cho phép gộp.
4. Mất response sau commit không buộc agent commit lại.
5. Report retry không chạy lại edit/commit/test khi artifact và source vẫn khớp.
6. Nhiều commit hợp lệ trong cùng ticket vẫn được xử lý bình thường.
7. Review/verification không được áp dụng cho source revision khác.
8. Lỗi projection nội bộ được tự phục hồi hoặc báo lỗi vận hành cụ thể, không mặc định `coder_blocked`.
9. No-op ticket và ticket chỉ điều tra vẫn có đường hoàn tất hợp lệ.
10. Có focused tests cho no-op, crash/retry, report retry, multi-commit và source drift.

## 8. Trạng thái hiện tại

- Tài liệu này chỉ ghi nhận phân tích và hướng sửa.
- Chưa chỉnh code.
- Chưa tạo commit hoặc push.
- Khi triển khai, phải kiểm tra working tree trước, chỉ sửa các file liên quan và chạy focused tests.

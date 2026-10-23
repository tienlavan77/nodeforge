<!-- Một checkpoint owner-execution dùng chung cho role System Engineer và Architecture Manager, kèm câu hỏi mở chưa chốt về agent có role coder; chưa phải quyền triển khai. -->
# Plan: Checkpoint owner execution dùng chung cho SE và AM

> **Trạng thái:** đề xuất architecture, chưa được human approve. Không sửa identity/revision/SHA của `workflows/plan-pause-resume-r2.md`, `workflows/plan-pause-resume-architecture.md`, `workflows/plan-role-scoped-chat-checkpoint-cleanup.md`; contract của ba tài liệu đó vẫn nguyên hiệu lực, kể cả quyết định retention "không cleanup tự động".
>
> **Không dùng tham chiếu ngoài:** năm lượt tìm web về shared checkpointer / durable-execution lease / namespace-per-agent-type (LangGraph, lease-per-thread, Temporal namespace) và về shared-table-discriminator vs separate-schema / checkpointer thread namespacing (ngày 2026-10-12) đều không trả về kết quả khả dụng, nên plan chỉ dựa trên evidence trong repo. Vì vậy việc chọn P1 hay P2 ở mục 3.2 phải dựa trên trade-off liệt kê tại đó, không dựa trên "thực hành chuẩn ngành".

## 0. Cách hiểu yêu cầu gốc

Yêu cầu: "dùng checkpoint chung cho cả SE, AM cho agent có role coder".

- `SE` = `system_engineer`, `AM` = `architecture_manager` (registry không có role nào khác khớp hai chữ tắt này).
- **Vế 1 đủ rõ để thiết kế:** hiện SE và AM **không hề dùng chung** checkpoint — chúng là hai instance của cùng một factory với `root` và `role` đóng băng lúc khởi tạo. "Dùng chung" do đó là một thay đổi thật về identity của store, không phải cách gọi tên.
- **Tách hai root là quyết định chủ ý, không phải hệ quả tình cờ:** human owner xác nhận (2026-10-12) lý do tách `owner-executions` / `architecture-executions` chính là **để hết lẫn lộn record giữa hai role**. Nói cách khác, phần "pain" mà plan này muốn xử lý là **code bị nhân bản**, còn phần "isolation bằng vị trí thư mục" là thứ đang mua được sự an toàn và không được mất đi. Vì vậy "dùng chung" có hai phương án tách biệt ở mục 3.2 — **chung code, riêng root** hoặc **chung cả store** — và chọn cái nào là quyết định của owner, không phải mặc định của plan. Không có bằng chứng repo nào cho thấy hai root từng được tách vì quên tham số hoá; evidence hiện tại (mục 3.1) cho thấy chúng đang gánh bốn trách nhiệm thật.
- **Vế 2 không tự suy ra được từ code:** `coder` bị loại khỏi owner execution ở cả ba tầng (mục 3.4). Plan này **không** mặc định rằng `coder` được cấp recovery của owner chat. Đây là quyết định cần human owner chốt; nếu được duyệt, đó là một plan riêng vì nó đổi cả mô hình quyền.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** một lượt chat SE và một lượt chat AM đi qua hai họ checkpoint vật lý khác nhau (`.forge/runtime/owner-executions` và `.forge/runtime/architecture-executions`). Cùng một bộ code `createOwnerExecutionCheckpoint` bị nhân bản bằng tham số `root`/`role` đông cứng, nên mọi sửa đổi về lease, receipt, reconciliation đều phải được áp hai lần và dễ lệch nhau giữa hai role. UI/control cũng phải chọn store theo kiểu nhị phân trước khi biết record nằm ở đâu. Pain cần chữa là **policy bị định nghĩa hai lần và dễ lệch**, không phải việc record của hai role nằm gần nhau — tách hai thư mục chính là biện pháp chống lẫn lộn mà owner chủ ý chọn (mục 0), nên phương án nào bỏ nó đi phải trả giá tương ứng, được định giá ở 3.2.
- **Kết quả:** SE và AM dùng **một** owner execution checkpoint — một root, một schema record, một đường khởi tạo — trong khi **chính sách vẫn phân theo role trên từng record**: record tự mô tả role của nó và mọi hành vi đặc thù (`run_check` settlement, single-mutation guard, evidence architecture, `can_reconcile`, owner auth) được quyết định từ `record.role` chứ không từ instance store. Record dở dang đang tồn tại ở root cũ vẫn phục hồi được sau khi gộp.
- **Giá trị:** một chỗ duy nhất để bảo đảm các bất biến pause/resume (lease, heartbeat, receipt trước khi ack, `manual_required` khi không chắc chắn) không bị lệch giữa hai role; giảm bản sao code trong file đã ở 223/250 dòng; giữ nguyên boundary quyền hạn của AM và SE.

## 2. Phạm vi

### In scope

- Gộp identity store của SE và AM về một checkpoint owner execution: một instance được wire ở composition root, một root lưu record, `role` trở thành thuộc tính của record (được suy ra phía Node từ conversation) thay vì tham số khởi tạo của store.
- Chuyển hành vi rẽ nhánh theo `role` hiện đang gắn với instance thành hành vi gắn với record, không nới lỏng bất kỳ ràng buộc nào: AM vẫn không có `run_check`/Git/commit/push, SE vẫn không dùng `delete_file` ngoài policy của mình, mỗi role vẫn giữ allowlist đường ghi.
- Định lại phạm vi lease: khi chỉ còn một store, lock theo conversation là hàng rào duy nhất; phải chứng minh hai lượt của hai role không bao giờ cùng `running` trong một conversation, và `Continue`/`Restart`/`Discard`/`reconcile` không thể tác động vào record của role khác.
- Kế hoạch chuyển tiếp cho record hiện có ở cả hai root, ưu tiên record chưa terminal (`running`, `pausing`, `interrupted`, `manual_required`); `.forge/` là runtime state do Node quản lý nên migration phải là code do Node chạy, không phải thao tác tay trên file.
- Kiểm thử: crash giữa write và receipt, lease hết hạn khi mutation đang chạy, hai process, reload trang, từ chối cross-role, và tính toàn vẹn lineage/audit của cả hai role sau gộp.

### Out of scope

- **Không** đổi chính sách quyền của bất kỳ role nào để cho tiện; gộp store không đồng nghĩa gộp đặc quyền.
- **Không** hợp nhất owner execution checkpoint với checkpoint ticket của Coder/Reviewer (`.forge/runtime/agent-checkpoints/${ticketId}.json`) — đây là hai subsystem khác nhau về khóa (conversation+execution so với ticket), về vòng đời và về ai khởi động; xem mục 3.4 và 6.
- **Không** xóa hay giữ thêm record terminal trái với `plan-pause-resume-r2.md` (không cleanup tự động) và chưa giải quyết được Blocker "chưa có nguồn audit độc lập" của `plan-role-scoped-chat-checkpoint-cleanup.md`.
- **Không** ấn định số ticket, tên ticket, DAG hay mutable-file manifest; SL tự phân rã sau khi plan được duyệt.
- **Không** pause/resume GO cho AM: báo cáo nghiệm thu Architecture hiện là NO-GO và plan này không thay điều đó.

## 3. Hướng tiếp cận và guardrails

### 3.1 Ràng buộc bắt buộc

- **Một implementation, nhiều role:** đúng một factory + một module policy được dùng cho cả hai role; mọi lựa chọn store nhị phân theo role trong application code phải bỏ. Record nào cũng mang `role` bất biến sau khi tạo. **Bất biến không được vi phạm dưới cả hai phương án ở 3.2:** sự phân cách role phải còn hiệu lực ở *đúng một* tầng — hoặc còn `root` riêng (phân cách vật lý), hoặc `record.role` được kiểm tra ở mọi cổng (phân cách logic). Không được tồn tại trạng thái trung gian "một root mà chưa có guard theo record"; đó chính là cửa hỏng mà mục 3.1 (4 trách nhiệm) mô tả.
- **Quyết định theo record, không theo instance:** toàn bộ nhánh `role === ...` hiện có phải đọc `current.role`. Nếu một nhánh nào không xác định được role từ record, fail closed (`manual_required`), không đoán.
- **Không mở rộng quyền:** `ROLE_TOOLS` và file policy vẫn là nguồn chân lý cho phép làm gì; checkpoint chỉ là lớp ghi nhận/recovery. AM tiếp tục không có receipt push vì role này không có push.
- **Hai root hiện tại không chỉ là quy ước tổ chức — chúng đang thực thi bốn trách nhiệm an toàn, và tên file record sau gộp không còn thành phần nào phân biệt role:** (1) `pathFor`/`load`/`list` ghép `root` vào đường dẫn và `list` glob `<root>/*.json` (`owner-execution-checkpoint.js:23-25,34-43`), nên hôm nay một store **về mặt cấu trúc không thể** đọc sang record của role khác; (2) khoá của `start()` là `<root>/<hash(conversationId)>.lock` (`:61`) và khoá của `update()` là `<path>.lock` (`:48`) — tức **hai role trong cùng một conversation hiện đang chạy song song hợp pháp**, gộp root là gộp luôn lease; (3) `ownerInstanceId` là `randomUUID()` sinh theo **instance** (`:19`) và là điều kiện của `patch()`/`markStopped()` (`:85-91,189-191`), nên hàng rào "lease thuộc về ai" cũng sinh ra từ việc tách instance chứ không từ dữ liệu; (4) có **mười dòng** chứa nhánh theo `role` đọc giá trị đông cứng của instance (mười một biểu thức), không phải ba: `patch` chặn ghi khi record AM đang `manual_required` (`:88`), `inspect` settlement `run_check` chỉ cho SE (`:98`), `beforeTool` guard single-mutation của AM (`:114`), `beforeTool` chặn AM chạy mutation chỉ-dành-cho-SE (`:115` — thông báo `"Architecture recovery cannot execute System Engineer mutations."`), `beforeTool` dựng evidence `prepareArchitectureMutation` (`:117`), `beforeTool` tăng `active_mutations` (`:119`), `afterTool` giảm `active_mutations` (`:130`), `failTool` vừa giảm `active_mutations` vừa chuyển `manual_required` (`:139`, hai lần), `canContinue` semantics `delete_file`/`expected_absent` (`:163`), `reconcilePending` đòi role AM (`:200`). Thêm ba cổng `owner_instance_id` cũng sinh từ instance chứ không từ record: `beforeTool` (`:112`), `afterTool`/`failTool` (`:128`/`:137`), `markStopped` (`:190`). Bốn trách nhiệm này phải được dựng lại bằng `record.role` **trước** khi gỡ `root`, và checklist guardrail phải đếm đủ danh sách trên — không chỉ các nhánh nằm trong nhóm hàm recovery.
- **Lease vẫn là một-attempt-mỗi-conversation:** sau khi gộp, hai role trong cùng conversation phải **tuyến tính hóa** trên một lease. Đây là hệ quả bắt buộc của "checkpoint chung" và phải được chủ ý chấp nhận, không phải tác dụng phụ.
- **Chống vượt quyền khi recovery:** `load/inspect/start(continueAttempt)/close/reconcile` phải từ chối khi `record.role` khác role của agent đang yêu cầu; `locate()` của control không còn là hàng rào duy nhất vì router sẽ không còn hai store để phân cách.
- **Không tự replay mutation:** write đã bắt đầu mà thiếu receipt vẫn `manual_required` cho tới khi Node xác minh checksum/sự vắng mặt thật của file.
- **Không sửa `.forge/` bằng tay, không xóa record để bypass reconcile.** Migration là code có test, idempotent, và không phá lineage.
- **Giới hạn 250 dòng:** `owner-execution-checkpoint.js` đã 223 dòng; thêm rẽ nhánh theo record gần chắc sẽ vượt. Bắt buộc tách chính sách role ra module riêng thay vì lớn dần.
- **Naming theo glossary:** giữ `owner-execution-checkpoint`/`conversation`/`lineage_id`; agent id mới dùng kebab-case (`architecture-manager`), không dùng `architecture_manager` cho id. Không tự sửa `vocabulary/glossary.md`.

### 3.2 Hai phương án "dùng chung" — owner phải chọn một trước khi SL lập SP

|  | **P1: chung code, riêng root** | **P2: chung cả store (một root)** |
| --- | --- | --- |
| Nội dung | Bỏ `role` đông cứng; policy đọc từ `record.role`. Giữ **hai** `root`, hoặc một instance nhận `root` theo lời gọi. | Một `root`, một instance, `role` là thuộc tính record. |
| Giải pain "sửa hai lần, dễ lệch" | **Đủ** — hành vi chỉ còn một chỗ định nghĩa. | Đủ. |
| Cách ly vật lý giữa hai role | **Giữ nguyên** (đường dẫn, glob, khoá lease theo root). | **Mất** — phải thay bằng guard `record.role` fail-closed. |
| Lease giữa hai role trong một conversation | Như hôm nay: không chặn lẫn nhau. | Trở thành tuyến tính — đổi hành vi đang chạy được thành không chạy được. |
| `ownerInstanceId` / `patch` / `markStopped` | Giữ nguyên (vẫn hai instance). | Hàng rào cũ sụp, phải dựng lại bằng `record.role` + instance của lượt đang chạy. |
| Migration `.forge/` | **Không có.** | Có; phải idempotent và không đụng record `manual_required`. |
| Rủi ro còn lại | Medium: vẫn phải bịt nhánh fail-open `record.role &&` (`owner-execution-control.js:21`). | High: bốn trách nhiệm ở 3.1 dựng lại + migration + auth gate + test cross-role. |

**Khuyến nghị của kiến trúc sư: P1**, trừ khi owner *chủ ý* muốn SE và AM đi chung một lease hội thoại. P1 bỏ đúng phần bản sao code — lý do thật của việc gộp — mà không phải mua lại chi phí cách ly, rủi ro ghi đè chéo role, và không đảo ngược quyết định tách thư mục đã nêu ở mục 0. Các bullets dưới đây và O1–O6 viết cho **P2**; nếu duyệt P1 thì O1/O4 đổi thành "một policy module dùng cho hai root; hai root vẫn không đọc được sang nhau", còn O4 (migration) bỏ và thay bằng test "không có đường nào ghép `root` của role khác vào `pathFor`".

- Extract một module policy thuần (ví dụ `owner-execution-role-policy.js`) trả về khả năng theo role: mutation nào được coi là "ghi", có cần `active_mutations` đếm hay không, `run_check` settlement có áp dụng không, reconcile cần owner auth không, cho phép `delete_file` semantics nào. Store giữ phần cơ chế (lock, file, heartbeat), policy giữ phần sai biệt — tránh một hàm 200 dòng chứa `if (role)`.
- Đổi `start()` sang nhận `role` theo lượt (đã suy ra phía Node từ conversation), ghi vào record một lần; bỏ tham số `role` của factory và bỏ tham số `root` (một root duy nhất).
- Chọn chiến lược đọc đường chuyển tiếp: hoặc migration một lần khi khởi động (quét root cũ, đổi tên/đặt lại vào root chung, giữ nguyên `execution_id` và `lineage_id`), hoặc load fallback theo root cũ cho record chưa terminal. Ưu tiên load fallback trước, di dời record làm sau, để không đụng record `manual_required` đang cần người xử lý.
- Cung cấp `rootLegacy` là danh sách đọc-only cho `load/list`, không phải cho `pathFor`, để không có record mới bị viết vào root cũ.

### 3.3 Dependency thật sự

- Hành vi lease gộp chỉ an toàn sau khi chứng minh `start()` và claim lock hoạt động đúng khi hai role cùng conversation (hiện thông báo lỗi còn hard-code chữ "A System Engineer execution...", sẽ sai với AM).
- Quyết định retention của r2 và Blocker audit độc lập của plan cleanup cần chốt trước, vì chúng xác định record nào còn sống tại thời điểm migration.
- Route HTTP execution cần auth nhất quán trước khi gộp store: `plan-role-scoped-chat-checkpoint-cleanup.md` đang ghi nhận GET execution không verify owner token; gộp store làm widening này nghiêm trọng hơn vì một list sẽ chứa record của cả hai role.

### 3.4 Quyết định chưa chốt — phần "agent có role coder"

Coder **không** nằm trong owner execution checkpoint hôm nay, bằng ba lớp tách biệt: router `storeFor()` chỉ nhận `system_engineer`/`architecture_manager` và ném 404 cho role khác; `owner-sdk-stream` chỉ vào nhánh SDK khi role thuộc hai role đó, còn lại rơi vào `fallbackStream`; `ROLE_TOOLS coder = READ_TOOLS`. Coder dùng subsystem khác: `createAgentExecutionCheckpointStore` khóa theo `${ticketId}.json`, do supervisor/ticket pipeline điều khiển, và `plan-role-scoped-chat-checkpoint-cleanup.md` đã tuyên bố checkpoint ticket là out of scope, muốn đổi phải replan.

Hai cách hiểu, chưa chọn:

- **Hiểu A (SE/AM chung, coder không đổi):** "cho agent có role coder" chỉ là ngữ cảnh — SE và AM cùng chuẩn bị/duyệt công việc mà sau đó coder thực hiện qua ticket; thứ cần chung là **danh tính** (`lineage_id`, plan identity, conversation), không phải lease. Nếu đúng ý này, plan này là đủ và không có outcome nào cho coder.
- **Hiểu B (coder được nạp vào owner checkpoint):** agent role `coder` được tham gia cùng một shared owner execution checkpoint. Điều này đổi mô hình quyền: coder hiện read-only trong tooling owner chat, mutation của coder lại gắn với ticket workspace và workspace root theo ticket, còn lease conversation của coder sẽ cạnh tranh với lease của SE/AM. Cần human owner duyệt riêng, kèm phân tích tương thích với `agent-execution-checkpoint` (ai sở hữu vòng đời record: ticket pipeline hay chat owner), trước khi SL lập SP.

**Khuyến nghị của kiến trúc sư:** chọn **Hiểu A** cho plan này; tách Hiểu B thành plan riêng. Gộp SE+AM đã có rủi ro đủ lớn (lease, migration, auth) mà không cần nhân lên bằng một role đang read-only.

### 3.5 Bộ lớp chống lẫn lộn (lẫn record, ghi đè, đọc nhầm)

Hôm nay "đang là role nào" được quyết định ở **ba nơi độc lập, và không chỗ nào đối chiếu ba giá trị đó với nhau**: `profile.role` đổi thành cờ `systemEngineer` rồi chọn store (`owner-sdk-stream.js:37,40`), `role` đông cứng trong store instance (`owner-execution-checkpoint.js:19`), và `record.role` đọc từ file (`owner-execution-control.js:21,31`). Mọi hình thái lẫn lộn đều là ba giá trị này lệch nhau. Hai thư mục đã không chặn được hai chỗ lệch như vậy (`:65` hard-code tên một role trong store của role kia; `control.js:21` bỏ qua record không có `role`), nên guard phải nằm trong code chứ không ở vị trí thư mục.

Xếp theo sức mạnh: **cấu trúc (không làm sai được) > được kiểm tra (làm sai thì kêu) > quy ước (nhờ người đọc)**. Cột P1/P2 cho biết phương án nào bắt buộc có guard đó.

| # | Cách lẫn lộn xảy ra | Guard đề xuất | P1 | P2 |
| --- | --- | --- | --- | --- |
| 0 | Ghép sai cặp `root`↔`role` khi wire store | Bỏ tham số rời và **bỏ cả giá trị mặc định**: một bảng `role → {root, display_name, policy}` duy nhất, factory chỉ nhận `role`, thiếu role là ném lỗi lúc khởi tạo | bắt buộc | bắt buộc |
| 1 | Record của role khác nằm nhầm chỗ vẫn được đọc như của mình | `load`/`list` đối chiếu `record.role === this.role`; lệch thì fail-closed (`manual_required` + log), không trả record | bắt buộc | bắt buộc |
| 2 | Record **thiếu** `role` lọt qua cổng phục hồi | `locate` bỏ điều kiện `record.role &&`, coi record không có `role` là 404/fail-closed | bắt buộc | bắt buộc |
| 3 | Restart **đọc nhầm** lineage của role khác (seed `completed_tool_calls`/`changed_paths`/`lineage_id` từ record kia) | Assert `parent.role === this.role` trước khi seed trong `start`; lệch thì từ chối (`EXECUTION_RECONCILIATION_REQUIRED`) | bắt buộc | bắt buộc |
| 4 | Record bị **ghi đè chính danh tính**: `patch` hợp nhất `{ ...current, ...fields }` không có allowlist trường (`owner-execution-checkpoint.js:85-91`), và `update` chỉ đóng dấu lại `conversation_id`/`execution_id` (`:53`) — `role`, `lineage_id`, `attempt_number`, `resume_of` đều đang **sửa được** nếu caller truyền vào | `update` khoá bất biến identity sau khi merge (ghép lại `role`/`lineage_id`/`attempt_number`/`resume_of` từ `current`, hoặc ném lỗi khi `fields` cố đổi chúng) | bắt buộc | bắt buộc |
| 4b | **Ghi đè chéo role qua `resumeOf`:** parent của role khác bị `close(..., "restarted")` sửa status và bị seed `completed_tool_calls`/`changed_paths`/`next_sequence` (`:73-79`). Hôm nay đường này chết vì `load` theo root khác → ENOENT → `EXECUTION_RECONCILIATION_REQUIRED` (`:74`), tức là fail-closed **nhờ hai root, không nhờ code** | Guard 3 ở trên là thứ thay thế nó khi còn một root; kèm test ghi thẳng `role` qua `patch` phải bị từ chối | đã có (nhờ root) | bắt buộc (chỉ còn guard) |
| 5 | Lease chặn nhầm bên | Lock key phải chứa đủ phạm vi role: P1 đã có `root` trong key, P2 phải thêm `role` vào key nếu muốn hai role chạy song song | đã có | bắt buộc |
| 6 | Người dùng **đọc nhầm** card recovery / thông báo lỗi | `summary()` trả `role` + tên hiển thị; thông báo busy lấy tên role từ store đang báo lỗi, không hard-code | bắt buộc | bắt buộc |
| 7 | Policy role định nghĩa hai lần rồi lệch | Một module policy tra theo role; role không có trong bảng → lỗi lúc khởi tạo, không đoán | bắt buộc | bắt buộc |

Thêm một assert rẻ ở seam: ngay sau `start()`, `owner-sdk-stream` kiểm tra `checkpoint.role === profile.role`. Một dòng, đổi "ba nguồn role" ở trên thành bất biến được kiểm tra đúng nơi chúng gặp nhau.

Không đề xuất đổi tên file record (thêm `role` vào filename) trong đợt này: tên hiện tại là `hash32(conversationId)-hash32(executionId).json` (`:23-25`), nên thêm thành phần nào cũng đổi identity của record và đòi chi phí migration ngang P2 — trong khi guard 0–2 đã cho cùng lợi ích với giá thấp hơn nhiều.

**Negative test tối thiểu:** xây store thiếu `root`/`role` phải ném lỗi; đặt một record role này vào root kia rồi `list`/`load` phải từ chối; `start({resumeOf})` trỏ vào record của role khác phải bị chặn; `locate` trên record không có `role` phải 404; thông báo busy phải nêu đúng role đang gọi.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Khu vực | Nhận xét | sha256 / kích thước |
| --- | --- | --- |
| `backend/src/application/owner-execution-checkpoint.js` | Factory nhận `root`, `role` đông cứng; nhánh role trong `inspect` (settlement `run_check` chỉ SE), `patch` (chặn ghi khi AM `manual_required`), `beforeTool`/`afterTool`/`failTool` (guard mutation đơn AM, evidence AM, đếm `active_mutations` chỉ AM), `canContinue` (`delete_file` khác nhau), `reconcilePending` (bắt buộc AM), `start` (ghi `role`, thông báo lỗi hard-code "System Engineer"), `close`. | `sha256:11740f4343c677efb71b45d677f08fdbc23340a18112ed5d274e9cd1f72b2aa9`, 223 dòng |
| `backend/scripts/control-api-http.mjs` | Composition root tạo **hai** instance (dòng 20–21) rồi truyền cả hai vào `createOwnerSdkStream` và `createOwnerExecutionControl` — đây là điểm gộp. | `sha256:5d6432d7390f95c723a23a4d0fb13117f76e656ff7c56bc896d5ccfa7fde094c`, 83 dòng |
| `backend/src/application/owner-sdk-stream.js` | Gate role hai giá trị rồi về `fallbackStream`; chọn store nhị phân `systemEngineer ? executionCheckpoint : architectureCheckpoint` (dòng 40); `start(...)` một lần/turn; heartbeat 10s; resume note mang `lineage_id`, `attempt_number`, steps bounded. | `sha256:e8e96950554b1d12343eac7f4aa69198c7eaa145189edcf32d788bf5f6e21fa3`, 184 dòng |
| `backend/src/application/owner-execution-control.js` | `storeFor()` phân store theo role và 404 cho role khác; `locate()` đối chiếu `record.role` với profile role; `summary()` đặt `can_reconcile` chỉ khi `record.role === architecture_manager`; `requiresOwnerAuth()` chỉ bật cho AM. | `sha256:52ac2321b96cd0062f2e5fddf8612db6ad96f1aca4f53a69c07d60db40e7c9e5`, 86 dòng |
| `backend/src/tools/owner-role-tool-policy.js` | `ROLE_TOOLS`: `coder`/`reviewer`/`sprint_leader` = `READ_TOOLS`; AM có `delete_file`, SE có `run_check`/Git/commit/push. Nguồn chân lý cho "gộp store ≠ gộp quyền". | `sha256:cc5782c8daea1eb8d81478fa964538520eb06d7a3dbe8227f93e728502aa1a3a`, 35 dòng |
| `backend/src/application/owner-execution-tools.js` | `checkpointOwnerTools()` bọc mọi Forge tool bằng `beforeTool`/`afterTool`/`failTool`; không đổi khi gộp, nhưng proof point cho receipt. | `sha256:7078d6e7c72884d09ae3943c7820bbb329f0ad3d4bc09a29a42cabd00e579af7`, 28 dòng |
| `backend/src/modules/agent/agent-execution-checkpoint.js` | Subsystem checkpoint thứ hai theo ticket (`agent-checkpoints`, `reviewer-checkpoints`), consumer là supervisor/pipeline/resume — bằng chứng coder nằm ở mô hình khác, không phải "thiếu wiring". | `sha256:627eb63d80886adcd04021717f97a7ec772fde6df342bb5551e4a226deaf22f7`, 93 dòng |
| `workflows/plan-pause-resume-r2.md` | Contract đã duyệt cho SE: restart dùng provider context mới, không auto Continue/Restart, lease race → `manual_required`, **không cleanup tự động**; out of scope: đổi semantics checkpoint ticket và mở rộng sang role read-only. | `sha256:ab4dae8c4e806ee23cbb029f48cd48f821a38b1fcf518f35240a78f985089f52`, 145 dòng |
| `workflows/plan-pause-resume-architecture.md` | Cấm rõ "dùng chung recovery record/endpoint của System Engineer mà không có role-specific authority" — ràng buộc 3.1 ở trên là cách đáp yêu cầu đó. | `sha256:613987d85babca64b9ba8f8b9d0a1a1bd134e30687d5482e2e2d8e42cd007988`, 72 dòng |
| `workflows/plan-role-scoped-chat-checkpoint-cleanup.md` | Định nghĩa "checkpoint" = owner execution hai trang, tuyên bố checkpoint ticket out of scope; còn mở Blocker GET execution chưa verify owner token và chưa có audit độc lập để xóa terminal. | `sha256:9f2f908f8cfadaeaaf13d3efc75272c751342e2e30ad1a68036a6f5439a34d41`, 78 dòng |
| `vocabulary/glossary.md` | Không có mapping cho "checkpoint"; có quy ước `conversation`, agent id kebab-case; agents không tự sửa file này. | `sha256:a9c423c18ec3a50428f71fcb229cc54db0e93476a946ab004695e0ac3b37d7c9`, 25 dòng |
| `workflows/agents/architecture/README.md` | Rulebook format plan và boundary ghi file của AM. | `sha256:8b3b25788f3f1167c9cc495ffb15c8e17cbd3434f6851f842d2c00c8dc92281d`, 146 dòng |

Danh sách trên là **candidate discovery**, không phải allowlist file được sửa; SL đọc lại SHA trước khi lập Sprint Plan vì source có thể đã đổi.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được |
| --- | --- | --- |
| O1 | Một checkpoint store phục vụ cả hai role | Composition root khai đúng một owner execution instance; không còn `root`/`role` đông cứng theo role; `owner-sdk-stream` và `owner-execution-control` không còn chọn store nhị phân; record mới của cả SE và AM nằm dưới cùng một root. |
| O2 | Policy theo record, không mất đặc quyền | Với `record.role = architecture_manager`: `run_check` không được settlement, guard mutation đơn và evidence architecture vẫn chạy, `delete_file` dùng semantics `expected_absent`, reconcile vẫn cần owner auth. Với `record.role = system_engineer`: settlement `run_check`, Git/commit/push receipt như r2. Test chứng minh mỗi nhánh lấy role từ record, không từ store. |
| O3 | Không rò rỉ recovery cross-role | Continue/Restart/Discard/reconcile nhắm vào record của role khác, hoặc execution của conversation/agent khác, đều 404/fail-closed; hai lượt của hai role trong cùng conversation không bao giờ đồng thời `running` (một bên nhận `EXECUTION_BUSY`); thông báo busy không còn hard-code tên một role. |
| O4 | Chuyển tiếp không mất khả năng phục hồi | Record chưa terminal ở root cũ vẫn được load và vẫn giữ `execution_id`, `lineage_id`, `attempt_number`, `resume_of`, receipts; migration/đọc fallback idempotent qua hai lần restart; `manual_required` không bao giờ bị "di cư" thành `running` hay bị xóa; không có thao tác tay vào `.forge/`. |
| O5 | Bất biến pause/resume còn nguyên | Crash giữa write và receipt → `manual_required` và server verify state thật; lease hết hạn khi mutation active → `manual_required`/`lease_expired_tool_active`; không tự động cleanup record; plan/identity và approval của Architecture không đổi bởi Pause/Restart. |
| O6 | Không phình file và không phá vocabulary | Mỗi file mới/sửa ≤ 250 dòng, phần sai biệt role được tách thành module policy có test riêng; tên mới dùng `conversation`/`owner-execution-checkpoint`, agent id kebab-case; `vocabulary/glossary.md` không bị sửa bởi agent. |
| O8 | Không thể lẫn record giữa hai role (áp dụng cho **cả P1 và P2**) | Chuỗi guard 0–4 và 6–7 ở mục 3.5 tồn tại và fail-closed: store không xây được nếu thiếu role hoặc phải dựa vào giá trị mặc định; `load`/`list`/`locate` từ chối record có `role` khác hoặc thiếu `role`; `start({resumeOf})` từ chối parent khác role; `patch`/`update` từ chối ghi đè `role`/`lineage_id`/`attempt_number`/`resume_of` (guard 4 — `owner-execution-checkpoint.js:53,85-91`); mọi nhánh `role === ...` trong store đọc `current.role` thay vì `role` đông cứng; không còn thông báo hay docstring nào hard-code tên một role. Mỗi guard có một negative test trong SP. |
| O7 *(chỉ khi owner chọn Hiểu B)* | Coder tham gia shared owner checkpoint | Không áp dụng cho phạm vi hiện tại; nếu được duyệt, plan riêng phải chứng minh: ai sở hữu vòng đời record của coder, lease conversation của coder có xung đột với SE/AM hay không, và quan hệ với `${ticketId}.json`. Không được suy ra từ O1–O6. |

SL tự lập Sprint Plan, phân rã ticket, mapping từng criterion sang verification và mutable-file manifest sau khi plan được duyệt. Plan này **không phải** Sprint Plan, không tự approve, không RUN, không dispatch.

## 6. Rủi ro, giả định và câu hỏi mở

| Vấn đề | Mức | Người chốt / cách xử lý |
| --- | --- | --- |
| Phần "agent có role coder" của yêu cầu không suy ra được từ code; hai cách hiểu cho kết quả thiết kế khác nhau | **Blocker scope** | Human owner/owner project chốt theo mục 3.4. Nếu chọn Hiểu B → plan riêng, không dispatch Hiểu B dưới vỏ plan này. |
| P2 đảo ngược một quyết định đã được owner nêu lý do chủ ý ("tách hai thư mục vì lẫn lộn") | **Blocker quyết định** | Human owner chốt P1 hay P2 ở mục 3.2 **trước** khi SL lập SP. Nếu không có xác thuận rõ ràng cho P2, kiến trúc sư đề xuất P1: đạt được mục tiêu anti-drift mà không phải dựng lại bốn trách nhiệm cách ly. |
| Gộp lease làm SE và AM chặn lẫn nhau trong cùng conversation | **Blocker hành vi** | Chủ ý chấp nhận và ghi thành test (O3), hoặc nếu owner muốn song song thì phải đổi khóa lease sang (conversation, role) — lúc đó "chung store" chỉ còn là chung code, phải nói rõ. |
| Mất hàng rào phân cách store khiến bug nhỏ thành vượt quyền recovery | **Blocker** | Enforce `record.role` ngay trong store cho `load/inspect/start/close/reconcile`, không chỉ ở router; negative test bắt buộc (O3). |
| Migration làm mất hoặc "làm sạch" record `manual_required` | **Blocker** | Chỉ di dời record chưa terminal bằng code có test, idempotent; ưu tiên đọc fallback trước khi di chuyển; cấm xóa trong cùng đợt. |
| GET execution chưa verify owner token + list chung hai role = lộ record chéo | **Blocker** | **Đã xác nhận trực tiếp, không còn là báo cáo chép từ plan cleanup:** `forge-v1-conversation-routes.js:15` trả `ownerExecutionControl.list(...)` cho `GET .../executions` mà không gọi verifier nào; chỉ nhánh `reconcile` gọi `planOwnerAuth.verify(headers)` (`:19-22`, lời gọi tại `:21`) — pause (`:23`) / continue / restart / discard (`:25`) cũng không verify. Chốt auth gate **trước** khi gộp; HTTP negative tests (nằm ở chặng 4, mục 9) |
| Cả P1 lẫn P2 vẫn còn kênh lẫn lộn nếu không dựng bộ lớp 3.5: ba nguồn `role` (`profile.role` trong stream, `role` đông cứng trong store, `record.role` trong file) chưa nơi nào đối chiếu nhau; `locate` bỏ qua record thiếu `role` (`owner-execution-control.js:21`); thông báo busy và docstring hard-code một role ngay trong store của role kia (`owner-execution-checkpoint.js:59,65`) | **Major** | Dựng guard 0–4 và 6–7 của mục 3.5 (O8) như một phần việc **không phụ thuộc** quyết định P1/P2 — xem mục 8 cho phạm vi tách được; negative test bắt buộc |
| `owner-execution-checkpoint.js` 223/250 dòng | Major | Tách policy module (3.2); không được phép vượt 250 dòng. |
| Test cũ giả định hai root (`architecture-execution.test.js`, `owner-execution-checkpoint.test.js`, `owner-builtin-tools.test.js`, `owner-sdk-tools.test.js`) | Major | SL rà test trước khi đổi wiring; giữ assertion về khác biệt hành vi, chỉ đổi cách instantiate. |
| Rủi ro nhầm "checkpoint chung" = hợp nhất với checkpoint ticket | Major | Nêu rõ out of scope (mục 2); nếu owner thực sự muốn hợp nhất subsystem thì cần đánh giá consumer supervisor/resume, không làm trong plan này. |
| Root/đường lưu mới và thời điểm migration chưa chốt | Minor | undecided: SL đề xuất trong SP; không ảnh hưởng contract record. |
| Có nên giữ `checkpoint_kind`/`provider` như hiện tại sau khi gộp | Minor | undecided: không đổi schema record trong đợt này trừ khi test chứng minh cần. |

## 7. Acceptance criteria của plan

- [ ] Human owner chốt **P1 hay P2** ở mục 3.2 (mức cô lập nào được giữ) — quyết định này thay đổi O1/O4 và cả phạm vi migration.
- [ ] Human owner trả lời rõ câu hỏi ở 3.4 (Hiểu A hay Hiểu B) trước khi SL lập Sprint Plan; nếu Hiểu B, plan này dừng ở phạm vi SE/AM và cần một plan thứ hai.
- [ ] Owner chấp nhận hệ quả lease "một-attempt-mỗi-conversation sau khi gộp" hoặc chỉ định đổi sang khóa (conversation, role); không để ngỏ.
- [ ] Mọi ràng buộc mục 3.1 tương thích với quyết định đã duyệt trong `plan-pause-resume-r2.md` và điều cấm trong `plan-pause-resume-architecture.md`; không có guardrail nào bị nới để đạt O1.
- [ ] O1–O6 đều có dấu vết kiểm chứng được (unit/integration/crash-race/HTTP negative), và không outcome nào suy ra từ kết quả pause/resume cũ vốn đang NO-GO.
- [ ] Không có mutable-file manifest, số ticket hay tên ticket nào bị khóa ở đây; SL giữ quyền phân rã.
- [ ] Human approval theo đúng identity/revision/SHA của tài liệu này trước khi triển khai; plan không tự RUN/dispatch và không phải Sprint Plan.

## 8. Điều kiện để bắt đầu code (definition of ready)

Tài liệu này là artifact kiến trúc, không phải quyền triển khai và không chứa Sprint Plan. Thứ tự bắt buộc:

1. **Human owner chốt ba quyết định:** P1 hay P2 (3.2), Hiểu A hay Hiểu B (3.4), và chấp nhận hệ quả lease hay đổi khóa lease sang (conversation, role) (mục 6, dòng Blocker hành vi). Kèm hai gate mượn từ plan cleanup: auth gate cho đường đọc execution (3.3) và chính sách retention, vì chúng quyết định record nào còn sống tại thời điểm gộp.
2. **Human approve đúng identity/revision/SHA-256** của tài liệu này. Sửa đổi sau approve tạo SHA mới và phải approve lại.
3. **SL lập Sprint Plan:** phân rã ticket, mutable-file manifest theo policy hiện hành, mapping từng criterion của O1–O6 và O8 sang verification. Architecture không làm bước này và không khóa số/tên ticket.
4. **Coder/Supervisor triển khai** sau khi SP được duyệt theo gates hiện hành. Architecture Manager **đọc được** `backend/**` (đã đọc `owner-execution-checkpoint.js`, `owner-execution-control.js`, `owner-sdk-stream.js`, `forge-v1-conversation-routes.js`) nhưng **không có quyền ghi và không chạy được test ở đó**, nên kể cả khi plan được approve, việc code không thuộc lượt của role này. Hệ quả nghiệm thu: mọi sha, số dòng và số pass/fail trích trong plan và lộ trình phải được SL đọc lại tại thời điểm dispatch — các con số ở đây là snapshot của lượt lập plan.

**Cluster 1 — self-contained, code được ngay sau khi human approve plan nguồn**, không cần owner trả lời thêm: các guard 1–4 và **một phần** guard 6 ở 3.5 (O8). Phần còn lại của guard 6 (tên hiển thị trong `summary()`/thông báo busy) tra từ bảng của guard 0 nên chỉ xanh sau chặng đó — xem `workflows/plan-owner-checkpoint-code-roadmap.md` R1.5. Lý do phân loại không phải "không liên quan P1/P2" mà là **cơ chế giải quyết**: mỗi mục này chỉ khớp nhãn với dữ liệu **đã có sẵn trong record**, không quyết định shape nào của store, nên cả P1 lẫn P2 đều giữ nguyên kết quả:

- `update` khoá nhóm trường identity sau merge. Hiện `owner-execution-checkpoint.js:53` chỉ đóng dấu lại `conversation_id`/`execution_id`/`updated_at`, còn `patch` hợp nhất `{ ...current, ...fields }` không có allowlist (`:85-91`) — nên `role`, `lineage_id`, `attempt_number`, `resume_of` đều đang sửa được.
- `locate` bỏ điều kiện `record.role &&` (`owner-execution-control.js:21`) để record không `role` bị coi là 404 thay vì lọt qua cổng phục hồi.
- `load`/`list` đối chiếu role. Hiện `list` mới chỉ lọc theo `record.conversation_id === conversationId` (`owner-execution-checkpoint.js:40`) — một trong hai chiều lẫn lộn đã có code gác, chiều role thì không.
- Bất đồng bộ role→store→policy: `summary()` trả `role` + tên hiển thị thay vì nhãn cố định, và thêm **một dòng** assert `checkpoint.role === profile.role` ngay sau `start()` (`owner-sdk-stream.js:37,40`). Tên hiển thị phải lấy từ bảng tra dẫn xuất của guard 0 chứ không phải một hằng số mới — vì vậy riêng bullet này merge sau R2, ba bullet trên thì không. Đây là mục duy nhất trong cluster đọc **cả ba nguồn role** cùng lúc, và nó chỉ so sánh những giá trị đã tồn tại.

**Caveat của cluster 1 — trùng file, không trùng quyết định.** `owner-execution-checkpoint.js` (223/250 dòng) là mục tiêu sửa của cả guard 1, guard 2, guard 6 **và** mọi mục thuộc cluster 2; guard 0 còn chạm thêm `backend/scripts/control-api-http.mjs:20` (composition root gọi factory **không tham số**, tức đang sống bằng default). Hệ quả: không phải "cluster 2 có thể code được", mà là **SL phải xếp lịch merge các thay đổi cùng file** (gộp thành một ticket hoặc tuần tự hoá) và phải canh trần 250 dòng. Kiến trúc ở đây chỉ ra ràng buộc, không chọn cách cắt ticket.

**Cluster 2 — blocked-on-decision: bốn mục sau cần một câu trả lời bằng văn bản của con người trước dòng code đầu tiên** (bản thân chúng không tự động áp dụng theo P1):

1. **Docstring `start`** (`:59`): "Reserves a single execution lease for a direct System Engineer turn." hoặc đổi chữ, hoặc thừa nhận machinery đang phục vụ cả AM — chọn một, vì đây là quyết định ngữ nghĩa chứ không phải sửa typo.
2. **`start()` lấy `role` từ đâu**: `profile.role` (`owner-sdk-stream.js:37,40`) hay Node suy theo lượt? Dưới P1 câu trả lời gần như mặc định, nhưng vẫn phải ghi trước khi code.
3. **Phạm vi lock key** (`owner-execution-checkpoint.js:48,61`): giữ `role` trong key (hai role song song hợp pháp) hay để tuyến tính. **Quyết định hành vi, owner trả lời.**
4. **`storeFor()` có giữ logic nhị phân không** (`owner-execution-control.js:8-35`) — chỉ relevant nếu P2.

O1/O4 và migration nằm sau cluster 2: chỉ định hình được khi P1/P2 chốt.

**Lộ trình code theo từng chặng** (R0–R6, dependency bắt buộc vs. gợi ý, trần file, rollback) tách sang `workflows/plan-owner-checkpoint-code-roadmap.md`. Tài liệu đó không thay đổi mục tiêu/phạm vi/outcome ở đây, không phải Sprint Plan, và không tự nới gate approve nào; khi plan nguồn sửa, SL/coder phải đối chiếu sha của cả hai.

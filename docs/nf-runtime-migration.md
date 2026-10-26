<!-- Documents preparation, offline cutover, and recovery for control-runtime regrouping.
Operators can preserve indexed conversations, approved plans, and resumable SDK homes while
keeping the existing pipeline-store migration and its journal independent. -->

# Migration cho .forge/runtime/nf

Phạm vi triển khai: mapping, tương thích đường dẫn, công cụ migration, kiểm thử và dry-run.
Không tự dừng Forge, không dọn log/cache/session và không áp dụng lên runtime thật.

## Mapping

| Nhóm | Mục |
| --- | --- |
| planning/ | plans, plan-clarifications, plan-requests |
| execution/ | tickets, sprint-plan, code-requests |
| history/ | conversations, conversation-migrations, summary |
| sdk/ | codex-homes, sdk-cache nếu có |
| maintenance/ | error-migrations, sprint-migration, sprint-migration-backups, sprint-migration-receipts |
| logs/ | project.log và toàn bộ file project.log.N |

Database nf/index.db cùng WAL/SHM, cấu hình, vault, khóa daemon, các log đã nằm
trong logs/ và các mục chưa phân loại giữ nguyên vị trí.
Không đổi NODE_CONTROL_DATA_DIR: nó vẫn là .forge/runtime/nf.
Công cụ hiện chỉ hỗ trợ dataDir mặc định này.

Marker và journal riêng: nf/nf-runtime-layout.json.
Khóa bảo trì riêng: nf/.nf-runtime-layout.lock.
Journal runtime/runtime-layout.json của migration 30 thư mục được giữ nguyên.
Cả hai migration từ chối chạy đồng thời.

## Tương thích và SDK home

FileService đọc/ghi được cả đường dẫn cũ và đường dẫn nhóm mới.
Database vẫn lưu raw_file, ticket_file, đường dẫn plan và byte offset như trước.
Nội dung JSONL, evidence, database SDK và các hash không bị viết lại.
Các đường I/O trực tiếp dùng resolver chung: SDK home/cache, sprint artifact,
log dự án, truy vấn log phục hồi và backup migration sprint.

Kiểm kê chỉ đọc ngày 2026-10-26 phát hiện 1.073 tham chiếu tuyệt đối tới session
trong 6 database SDK. Vì vậy sau apply có một alias cố định:

```text
nf/codex-homes -> sdk/codex-homes
```

Đây là alias tương thích được kiểm chứng đúng đích trong project.
Không xóa alias sau chuyển đổi: database SDK còn tham chiếu đường dẫn này.
Rollback xử lý alias trước khi chuyển nguyên home trở lại.

Symlink tương đối chỉ được giữ nếu đích nằm trong cùng store đang chuyển.
Plugin có repository Git độc lập với .git là thư mục được hỗ trợ.
Git worktree, commondir, cấu hình worktree riêng, liên kết thoát store hoặc
liên kết sang state khác đang chuyển sẽ chặn migration.

## Bước 4: dry-run khi Forge còn chạy

Từ project root:

```sh
node backend/bin/forge-nf-runtime-migrate.mjs
```

Lệnh này không tạo khóa hay marker và không di chuyển dữ liệu.
Nó báo planned, absent, already_grouped, conflict, các mục giữ nguyên,
writer/khóa phát hiện được, số file và số byte của từng store.
Kiểm tra cấu trúc không đọc nội dung session để tính hash.
Số liệu có thể thay đổi vì writer vẫn hoạt động.

Blockers rỗng không chứng minh SDK đã dừng: SDK có khóa nội bộ không chứa PID.
requiresOffline và requiresSdkStopped luôn được báo.
migrationReady vẫn false trong preview vì chưa có cửa sổ bảo trì.

## Bước bảo trì tiếp theo: chưa thực hiện

Chuẩn bị shell độc lập với phiên Forge này. Dừng cơ chế tự restart,
Control API, watcher, mọi tiến trình SDK con và các writer thủ công.
Lấy backup nhất quán của toàn bộ nf sau khi dừng, gồm SQLite/WAL/SHM và SDK homes;
giữ backup ngoài cây nf để nó không tự chứa chính archive.
Kiểm tra đọc lại archive và SHA-256 trước khi chuyển.

Sau đó mới chạy:

```sh
node backend/bin/forge-nf-runtime-migrate.mjs --apply --offline --sdk-stopped
node backend/bin/forge-nf-runtime-migrate.mjs
```

offline và sdk-stopped là xác nhận vận hành; chúng không tự dừng process.
Công cụ vẫn kiểm tra khóa daemon và khóa state có PID, không bỏ qua writer sống.
Do phạm vi truy cập chỉ nằm trong project, không dùng quét /proc để thay thế
việc người vận hành xác nhận SDK con đã dừng.

Apply hash toàn bộ nội dung trước khi di chuyển, ghi journal bền vững,
đổi tên từng store, hash lại đích, tạo alias rồi công bố layout grouped/ready.
Store chưa có được tạo trong nhóm tương ứng khi ứng dụng cần ghi lần đầu.

Kiểm tra không còn planned/conflict và các store hiện có đều already_grouped,
đọc hội thoại, plan, log và session giữ lại trước khi bật writer.
Sau khi khởi động lại, kiểm tra resume và điều phối ticket.

## Rollback

Giữ writer dừng và chạy:

```sh
node backend/bin/forge-nf-runtime-migrate.mjs --rollback --offline --sdk-stopped
```

Rollback chỉ xử lý endpoint thuộc mapping cố định và dữ liệu còn nguyên hash.
Nếu đã có dữ liệu mới sau cutover, nó từ chối thay vì ghi đè hoặc bỏ dữ liệu.
Migration bị ngắt giữ status migrating để chặn startup và state access.

Nếu process chết để lại .nf-runtime-layout.lock, xác minh PID đó đã thoát,
chỉ bỏ fence cũ rồi chạy rollback. Không xóa journal để bỏ qua phục hồi.

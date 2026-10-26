<!-- Records the measured NodeForge control-runtime inventory and a functional regrouping proposal.
This audit separates active state, resumable SDK history, and archival candidates so later migration
work can preserve database references and avoid treating persistent sessions as disposable cache. -->

# Kiểm kê và đề xuất sắp xếp runtime/nf

Ngày kiểm tra: 2026-10-26. Phạm vi: dữ liệu trong project và code đọc/ghi hiện tại.
Đây là kết quả khảo sát; chưa di chuyển, nén hay xóa dữ liệu runtime.
Các số liệu được lấy khi Forge đang chạy và có thể tiếp tục tăng.

## Số liệu

Có 34 mục ở cấp đầu: 19 thư mục và 15 file.
Dung lượng cấp phát đo bằng du: 4,17 GiB, tương đương khoảng 4,2 GiB.
File log được tính theo kích thước nội dung; các thư mục tính theo dung lượng cấp phát.

| Thành phần | Dung lượng | Ý nghĩa |
| --- | ---: | --- |
| codex-homes | 3.183 GiB | 19 home; gồm lịch sử resume, SQLite và thư mục tạm |
| codex-homes/*/sessions | 2.257 GiB | Lịch sử SDK cần đối chiếu với thread còn dùng |
| codex-homes/*/.tmp | 603,9 MiB | Ứng viên kiểm tra dọn tạm; chưa xác nhận có thể xóa |
| SQLite và các file khác ở cấp home | khoảng 340 MiB | Bao gồm state và thread history; không coi là cache |
| project.log, project.log.2, project.log.3 | 665,9 MiB | Log dự án và các bản chia theo kích thước |
| conversations | 233,6 MiB | Nội dung JSONL được database tham chiếu theo byte offset |
| sprint-migration-backups | 37,6 MiB | Backup có manifest phục vụ phục hồi migration sprint |
| logs | 2,4 MiB | Log node, watcher, web và cầu nối SDK |

Database điều hành đang dùng là nf/index.db cùng WAL/SHM.
control.db có kích thước 0 byte; không có tham chiếu literal trong code ứng dụng đã quét.
Code mặc định mở index.db tại dataDir, không mở control.db.

Truy vấn chỉ đọc agent_communications xác nhận:

- 38.769 dòng đang tham chiếu conversations/.
- 50 dòng đang tham chiếu conversation-migrations/.

Không đọc nội dung secrets.vault, cấu hình credential, transcript hay log SDK.
Không kiểm tra process qua dữ liệu hệ thống ngoài project.

## Cấu trúc đề xuất

Giữ nguyên các tên lá trong lần chuyển đầu:

| Nhóm | Mục chuyển vào | Ghi chú |
| --- | --- | --- |
| planning/ | plans, plan-clarifications, plan-requests | Kế hoạch và trao đổi làm rõ |
| execution/ | tickets, sprint-plan, code-requests | Dữ liệu điều phối; khác state pipeline ở runtime/tickets |
| history/ | conversations, conversation-migrations, summary | Giữ nguyên nội dung, hash, offset và tham chiếu lịch sử |
| sdk/ | codex-homes | Home phải chuyển nguyên bộ; sdk-cache vào cùng nhóm khi được tạo |
| maintenance/ | error-migrations, sprint-migration, sprint-migration-backups, sprint-migration-receipts | Giữ cả nguồn, backup và receipt |
| logs/ | project.log và toàn bộ các bản chia hiện có | Tận dụng thư mục logs đang tồn tại |

Giữ index.db, index.db-wal, index.db-shm, agent-config.json, secrets.vault và
hai khóa daemon tại gốc nf trong đợt đầu. Việc này giới hạn thay đổi đối với
khởi động, cấu hình bảo mật và khóa vận hành.

SDK sẽ dùng cùng home ở vị trí mới sau khi cập nhật codexHomeRoot.
Không đổi tên agent hoặc thread để phục vụ việc gom thư mục.

## Các mục cần xác minh nguồn gốc riêng

- baseline-reconciliation/ và plan-resets/: không thấy literal trong source hiện tại.
- .forge/runtime/index.db bên trong nf: database lồng khoảng 264 KiB;
  chưa xác nhận schema, nguồn tạo hoặc các tham chiếu động.
- .claude/.cc-writes: thư mục rỗng tại thời điểm kiểm tra; chưa kết luận bỏ được.
- control.db, control-api.log, watcher.log và human-plan-canary-agent-backup.json:
  ứng viên lưu trữ lịch sử, chưa được phân loại là rác.
- dev-forge.pids.json: không thấy literal trong source nhưng tài liệu vận hành
  FORGE-OPS-001c vẫn đề cập; cần đối chiếu cách nạp daemon trước khi loại bỏ.

Không có literal trong source không chứng minh một mục không còn được dùng.
Các mục trên giữ nguyên cho tới khi có bằng chứng và quyết định lưu trữ phù hợp.

## Công việc triển khai tiếp theo

1. Thêm mapping riêng cho nf; giữ nguyên marker và mapping 30 thư mục đã chuyển.
2. Cập nhật cả FileService lẫn các đường truy cập trực tiếp, cấu hình dataDir,
   codexHomeRoot, log reader/writer, và các script backup/migration.
3. Giữ tương thích raw_file cũ của agent_communications; không viết lại JSONL
   hoặc thay đổi byte offset. Kiểm tra cả dữ liệu conversation-migrations.
4. Giữ tương thích đường dẫn plan trong database, kiểm tra lại quyền truy cập
   plan của FileService hiện đang có biểu thức cố định nf/plans.
5. Thêm dry-run, khóa bảo trì, journal, kiểm chứng và rollback cho mapping nf.
   Khi chuyển SDK home phải dừng cả các tiến trình SDK con, không chỉ daemon.
6. Kiểm thử lịch sử hội thoại, resume checkpoint/thread, plan clarification,
   ticket dispatch, log query và backup sprint trên fixture trước khi chuyển thật.

## Chính sách dung lượng cần tách khỏi migration

Chỉ gom thư mục không làm giảm dung lượng.

- Log: code hiện đặt ngưỡng mặc định 256 MiB mỗi file và tạo thêm bản chia;
  chưa có giới hạn tổng số bản. Cần chính sách giữ/nén/archive riêng.
- SDK .tmp: xác minh nội dung, writer và vòng đời trước khi thêm cơ chế dọn.
  Con số 603,9 MiB là dung lượng quan sát, không phải cam kết thu hồi.
- Session: đối chiếu agent còn cấu hình, thread trong conversation state,
  execution checkpoint và writer trước khi xác định home/session được archive.
- Backup migration: giữ manifest và khả năng phục hồi trước khi áp dụng thời hạn lưu.

## Code làm bằng chứng

- backend/scripts/control-api-storage.mjs: database điều hành và khóa tiến trình.
- backend/scripts/control-api-agent.mjs: agent-config, secrets và codexHomeRoot.
- backend/src/modules/agent/codex-sdk-gateway.js: home theo agent và resume thread.
- backend/src/modules/agent/codex-thread-writer.js: kiểm tra thread còn writer.
- backend/src/modules/agent/codex-shell-environment.js: vị trí sdk-cache dự kiến.
- backend/src/core/project-log-service.js: đọc log và chia file theo dung lượng.
- backend/src/modules/governance/agent-communication-store.js: raw_file và byte offset.
- backend/src/modules/governance/conversation-error-migration.js: dữ liệu chuyển đổi có index.
- backend/scripts/sprint-registry-migration-runtime.mjs: backup và receipt migration sprint.
- backend/src/infrastructure/filesystem/file-service.js: quyền truy cập plan và đường dẫn state.

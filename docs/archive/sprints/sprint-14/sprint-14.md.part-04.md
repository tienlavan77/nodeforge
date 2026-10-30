<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
Agent B


==================================================
TESTING POLICY
==================================================

Mỗi NF phải có:

1. Test mới cho functionality của NF.
2. Test liên quan đến module bị ảnh hưởng.
3. Regression của các ticket dependency.

Không chỉ chạy test mới.

Real Agent test phải được phân biệt:

UNIT:
Mock Agent được phép.

INTEGRATION:
Real Gateway / Real Agent bắt buộc.

E2E:
Real Agent bắt buộc.


==================================================
BROWSER VERIFICATION
==================================================

Sprint 14 phải luôn có browser verification.

Browser:

http://localhost:4174/

Project Owner phải có thể:

- mở Agent Settings
- cấu hình Agent
- test connection
- chat
- nhận response thật
- xem realtime stream
- xem History


==================================================
QUALITY GATES
==================================================

Mỗi ticket:

- New tests
- Related tests
- Regression
- Lint
- Typecheck
- Schema validation
- git diff --check

Ticket có UI:

- Web build
- Node API smoke
- Browser verification

Ticket Real Agent:

- Real Gateway test
- Real Agent result


==================================================
WORKTREE SAFETY
==================================================

Không commit thay đổi ngoài scope.

Nếu phát hiện:

- ARCHITECTURE.md
- sprints/
- user artifacts
- thay đổi của ticket khác

DỪNG trước khi commit và báo cáo.

Không tự ý commit.


==================================================
SPRINT 14 DEFINITION OF DONE
==================================================

Sprint 14 hoàn tất khi:

[ ] Agent Profile tồn tại

[ ] Node configuration hoạt động

[ ] Gateway abstraction hoạt động

[ ] Agent Settings UI hoạt động

[ ] Architecture Manager kết nối Agent thật

[ ] Real Agent request/response PASS

[ ] Real Agent streaming PASS

[ ] SSE PASS

[ ] Persistence PASS

[ ] Restart/recovery PASS

[ ] History PASS

[ ] Credential redaction PASS

[ ] Architecture Manager Real E2E PASS

[ ] Không Web UI → Agent direct connection

[ ] Không Agent → Agent direct connection

[ ] Full regression PASS


==================================================
SPRINT 14 TICKET ORDER
==================================================

NF-144 — Agent Profile Contract & Store
        ↓
NF-145 — Node Agent Configuration
        ↓
NF-146 — Agent Gateway / Connection Layer
        ↓
NF-147 — Agent Settings UI
        ↓
NF-148 — Real Agent Request & Response
        ↓
NF-149 — Real Agent Streaming
        ↓
NF-150 — Real Agent E2E
<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->

Node phải:

- nhận stream
- preserve ordering
- stream qua SSE
- persist/audit theo architecture hiện tại
- chống duplicate
- hỗ trợ reconnect/replay


Không fake streaming.

Nếu Agent trả response hoàn chỉnh:

Không được giả lập chunk để tuyên bố streaming thật.

Phải phân biệt:

REAL STREAMING
vs
NORMAL RESPONSE


Acceptance:

[ ] Real Agent stream
[ ] Node nhận stream
[ ] SSE stream
[ ] UI render realtime
[ ] ordering đúng
[ ] reconnect
[ ] replay
[ ] duplicate protection
[ ] persistence
[ ] credential redaction


==================================================
NF-150 — Real Agent E2E
==================================================

Mục tiêu:

Chứng minh toàn bộ Real Agent Connectivity flow bằng
Architecture Manager thật.

Flow:

Project Owner
 ↓
Web UI
 ↓
Node
 ↓
Agent Profile
 ↓
Configuration
 ↓
Gateway
 ↓
REAL Architecture Manager
 ↓
Node
 ↓
Communication Store
 ↓
SSE
 ↓
Web UI


Phải kiểm chứng:

1. Configure Agent
2. Save Profile
3. Test Connection
4. Send message
5. Real Agent receives message
6. Real Agent responds
7. Node receives response
8. Communication persisted
9. Response streamed to UI
10. Browser refresh
11. History vẫn tồn tại
12. Node restart
13. Connection/config reload
14. Conversation vẫn tồn tại


==================================================
REAL AGENT EXPANSION
==================================================

NF-150 chỉ cần chứng minh:

Architecture Manager = PASS

Sau đó mới mở rộng:

Architecture Manager
        ↓
Sprint Leader
        ↓
Builder
        ↓
Reviewer


Không bắt buộc 4 Agent phải hoàn thành trong
NF-150 nếu Architecture Manager reference implementation
đã chứng minh được architecture.


==================================================
CREDENTIAL SECURITY
==================================================

API Key / credential tuyệt đối không được xuất hiện trong:

- React state lâu dài
- Conversation
- Communication Store
- Event Store
- History
- Memory
- SSE
- browser response
- log
- error message
- Git

UI chỉ hiển thị:

********


==================================================
PERSISTENCE
==================================================

Tận dụng infrastructure hiện có:

- Communication Store
- Event Store
- History
- Architecture Decision Store
- Roadmap Store
- Agent Session persistence
- Node configuration

Không tạo:

- Chat Store mới
- Agent Message DB mới
- Credential Store tùy tiện
- Agent-specific persistence authority


==================================================
NODE AUTHORITY
==================================================

Node là boundary duy nhất giữa Web UI và Agent.

Bắt buộc:

Web UI
 ↓
Node
 ↓
Agent

Không:

Web UI
 ↓
Agent


Nếu Agent A cần nói chuyện với Agent B:

Agent A
 ↓
Node
 ↓
Communication Bus
 ↓
Node
 ↓

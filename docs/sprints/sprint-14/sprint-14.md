SPRINT 14 — REAL AGENT CONNECTIVITY

Mục tiêu:

Chuyển hệ thống từ Agent connection hiện tại sang khả năng
cấu hình, kết nối và giao tiếp với Agent thật thông qua Node.

Web UI KHÔNG kết nối Agent trực tiếp.

Flow mục tiêu:

Project Owner
      ↓
Web UI
      ↓
Node
      ↓
Agent Profile
      ↓
Agent Gateway
      ↓
REAL AGENT
      ↓
Node
      ↓
SSE
      ↓
Web UI


Reference Agent đầu tiên:

Architecture Manager

Sau khi Architecture Manager hoàn tất real-agent E2E,
mới mở rộng sang:

- Sprint Leader
- Builder
- Reviewer


==================================================
KIẾN TRÚC SPRINT 14
==================================================

NF-144
Agent Profile Contract & Store
        ↓
NF-145
Node Agent Configuration
        ↓
NF-146
Agent Gateway / Connection Layer
        ↓
NF-147
Agent Settings UI
        ↓
NF-148
Real Agent Request & Response
        ↓
NF-149
Real Agent Streaming
        ↓
NF-150
Real Agent E2E


==================================================
NF-144 — Agent Profile Contract & Store
==================================================

Mục tiêu:

Tạo contract và persistence chuẩn để Node quản lý profile
của từng Agent.

Agent:

- Architecture Manager
- Sprint Leader
- Builder
- Reviewer

Profile tối thiểu:

- agent_id
- agent_name
- gateway_url
- credential reference
- enabled
- created_at
- updated_at

Store hỗ trợ:

- create
- update
- getById
- getAll

Yêu cầu:

- validate profile
- reject duplicate agent_id
- reject invalid profile
- immutable input
- không expose mutable state

Không làm:

- UI
- Gateway connection
- Real Agent
- Streaming
- API Key transmission

TEST:

- Profile validation
- Store CRUD
- Duplicate protection
- Immutability
- Schema validation
- Related Agent regression


==================================================
NF-145 — Node Agent Configuration
==================================================

Mục tiêu:

Node quản lý configuration của Agent Profile và credential
theo đúng Node configuration boundary.

Flow:

Agent Profile
      ↓
Node Configuration
      ↓
Environment / secure local config


Yêu cầu:

- tạo configuration
- update configuration
- load configuration
- giữ configuration ngoài scope
- không hard-code credential
- credential không xuất hiện trong log
- credential không xuất hiện trong communication/history/event

Node tự tạo/update environment configuration khi cần.

Không để Web UI trực tiếp quản lý filesystem.

TEST:

- create config
- update config
- reload config
- multiple agents
- credential redaction
- restart
- invalid config
- regression


==================================================
NF-146 — Agent Gateway / Connection Layer
==================================================

Mục tiêu:

Tạo abstraction để Node kết nối Agent thông qua Gateway.

Flow:

Node
 ↓
Agent Gateway
 ↓
Configured Gateway URL
 ↓
Agent


Gateway phải xử lý:

- request
- authentication/credential injection
- response
- timeout
- connection error
- unavailable Agent

Web UI không gọi Gateway.

Agent adapter không đọc UI/config trực tiếp.

Có thể dùng mock Gateway cho unit test.

Không được tuyên bố Real Agent PASS bằng mock.


TEST:

- connection
- authentication
- timeout
- invalid gateway
- unavailable Agent
- response handling
- credential redaction
- regression


==================================================
NF-147 — Agent Settings UI
==================================================

Mục tiêu:

Cho Project Owner cấu hình Agent từ Web UI.

Mỗi Agent Chat Panel có menu:

Agent Settings

Các field:

- Agent Name
- Agent ID
- Gateway URL
- API Key
- Enabled

Actions:

- Save
- Test Connection

API Key hiển thị masked.

Flow:

Web UI
 ↓
Node API
 ↓
Agent Profile / Configuration

Không:

Web UI → Gateway
Web UI → Agent


Giữ layout đã chốt:

Architecture Manager:
3/7 width, full height

Right:
4/7 width

Sprint Leader:
1/3

Builder:
1/3

Reviewer:
1/3


TEST:

- settings render
- save
- update
- masked credential
- validation
- test connection
- error state
- regression NF-138/NF-141


==================================================
NF-148 — Real Agent Request & Response
==================================================

Mục tiêu:

Kết nối Architecture Manager với Agent thật.

Flow:

Project Owner
 ↓
Architecture Manager Chat
 ↓
Node
 ↓
Agent Gateway
 ↓
REAL Architecture Manager
 ↓
Node
 ↓
Web UI


Không dùng fake response trong real-agent path.

Node phải:

- route request
- inject credential
- giữ correlation_id
- nhận real response
- persist communication
- publish result
- trả response về UI


Acceptance:

[ ] Architecture Manager nhận request thật
[ ] Agent trả response thật
[ ] Node nhận response
[ ] Communication persist
[ ] correlation_id giữ nguyên
[ ] UI nhận response
[ ] Không direct Web UI → Agent
[ ] Không fake response


Nếu môi trường không có Gateway/credential thật:

REAL AGENT TEST = BLOCKED

Không được báo PASS bằng mock.


TEST:

- real request
- real response
- error handling
- timeout
- persistence
- correlation
- credential redaction
- regression


==================================================
NF-149 — Real Agent Streaming
==================================================

Mục tiêu:

Stream response thật của Agent qua Node lên đúng Chat Panel.

Flow:

REAL AGENT
    ↓
Agent stream
    ↓
Node
    ↓
SSE
    ↓
Architecture Manager Chat


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
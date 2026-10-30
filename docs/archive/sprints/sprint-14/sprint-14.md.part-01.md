<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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



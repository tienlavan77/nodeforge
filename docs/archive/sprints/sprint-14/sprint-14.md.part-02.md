<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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


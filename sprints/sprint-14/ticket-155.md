NF-155 — Agent Provider Adapter Layer

Mục tiêu:

Tách Agent Gateway khỏi provider cụ thể để Node có thể kết nối
nhiều Agent Provider.

Kiến trúc:

Agent Profile
    ↓
Agent Gateway
    ↓
Provider Adapter
    ↓
Provider-specific transport
    ↓
Real Agent

Provider Adapter phải chuẩn hóa về Node contract:

- request
- response
- streaming delta
- completion
- error
- timeout
- correlation_id

Provider-specific protocol không được leak lên UI,
Communication Store hoặc SSE.

Provider:

- Codex
- Claude
- OpenAI
- Anthropic
- Custom / OpenAI-compatible

Codex:

- Kiểm tra implementation hiện tại đang kết nối Codex
  bằng Codex CLI hay HTTP/API.
- Giữ behavior hiện tại nếu đang PASS.
- Đưa Codex implementation vào adapter tương ứng.
- Không giả định transport hiện tại nếu chưa kiểm tra code.

Agent Profile:

Hỗ trợ provider selection:

- provider
- protocol/adapter type nếu cần
- gateway_url
- model
- credential_ref

Không lưu API key trong Profile/Config.

Secret:

- Resolve duy nhất tại Gateway/adapter boundary.
- Dùng NF-151 Secret Backend.
- Không credential leak vào response/error/history/SSE.

Không làm:

- Không hard-code Codex làm provider mặc định của architecture.
- Không tạo Gateway riêng cho từng provider.
- Không đưa provider-specific logic vào UI.
- Không thay đổi canonical Agent Stream contract nếu không cần.
- Không mock để tuyên bố Real Agent support.

TEST:

- Adapter contract.
- Codex adapter regression.
- Provider selection/configuration.
- Request/response normalization.
- Streaming normalization.
- correlation_id.
- Timeout/error.
- Credential redaction.
- Multiple provider adapters.
- NF-146 Gateway regression.
- NF-147 Agent Settings regression.
- NF-148/149/150 streaming regression.
- NF-151/152 secret regression.
- Lint
- Typecheck
- Schema validation
- Web build
- git diff --check

Nếu provider chưa có endpoint/credential thật:
không fake PASS; ghi rõ BLOCKED.

Không commit ARCHITECTURE.md, sprints/, .DS_Store.

Commit:
NF-155 PASS: add Agent Provider Adapter Layer
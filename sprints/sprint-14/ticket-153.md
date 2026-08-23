NF-153 — Multi-Agent Tabbed Chat UI

Mục tiêu:

UI có 4 Agent Tabs:

- Architecture Manager
- Sprint Leader
- Builder
- Reviewer

Mỗi tab có:

- Conversation riêng.
- Chat trực tiếp qua Node.
- Agent Settings riêng.
- Provider selection.
- Gateway URL.
- API Key.
- Model.
- Save / Test Connection.

Provider:

[ Codex ▼ ]
[ Claude ]
[ OpenAI ]
[ Anthropic ]
[ Custom / OpenAI-compatible ]

- Provider chỉ là cấu hình Agent.
- Không hard-code provider logic trong UI.
- Không lưu API key plaintext.
- Secret tiếp tục dùng NF-151.
- Test Connection đi qua Node/Gateway.
- Provider-specific connection được xử lý bởi NF-155.

Chat:

- 4 tab chuyển qua lại.
- Không hiển thị 4 chat cùng lúc.
- Mỗi Agent có conversation riêng.
- Agent đang working → disable input của chính Agent đó.
- Agent khác vẫn chat được.
- Working status nhấp nháy.
- Giữ streaming/replay hiện tại.

Architecture Manager:

Chỉ Architecture Manager có:

[ Approve ] [ Request Changes ] [ Reject ]

Decision controls nằm ngay trong proposal/conversation.

Các Agent khác không có decision controls.

Giữ layout tổng thể 3/7 + 4/7.

Không thay đổi Agent Gateway contract trong NF-153.
Không implement provider adapter trong NF-153.

TEST:

- 4 tab.
- Provider selection cho cả 4 Agent.
- Save/reload provider config.
- Gateway URL.
- API key masking.
- Test Connection.
- Chat routing đúng agent.
- Working/disabled input.
- Architecture decision controls.
- Streaming/replay regression.
- Related tests NF-144 → NF-152.
- Lint
- Typecheck
- Schema validation
- Web build
- git diff --check

Browser verification bắt buộc.

Không commit ARCHITECTURE.md, sprints/, .DS_Store.

Commit:
NF-153 PASS: add Multi-Agent Tabbed Chat UI
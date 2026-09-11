NF-154 — File-Backed Conversation Storage

Mục tiêu:

Thay đổi cách lưu conversation để raw chat không nằm trực tiếp
trong SQLite.

Kiến trúc:

Conversation raw data
    ↓
File-backed storage
    ↓
Conversation Index (SQLite)
    ↓
conversation_id / agent_id / message_id / timestamp / location

Yêu cầu:

- Lưu raw conversation trên file.
- SQLite chỉ giữ index/metadata và mapping tới file/chunk.
- Hỗ trợ 4 Agent.
- Conversation tách theo conversation_id.
- Append message hiệu quả.
- Không persist từng streaming delta thành DB record.
- Completion tạo/cập nhật canonical assistant message.
- Replay/reconnect đọc được từ file + index.
- Query conversation không cần scan toàn bộ raw storage.
- Node restart vẫn load được conversation/index.
- Giữ nguyên Communication Store API nếu có thể để giảm
  ảnh hưởng các module hiện tại.
- Không lưu API key/secret vào conversation storage.

Streaming:

Real Agent
   ↓
Node
   ├──→ SSE → UI
   └──→ Conversation Writer → file
                         ↓
                    Index update

Không để SQLite nằm trên critical path của streaming.

Migration:

- Không làm mất conversation hiện có.
- Nếu database hiện tại đang chứa raw messages, phải có
  migration/compatibility strategy rõ ràng.
- Không tự xóa dữ liệu cũ.

TEST BẮT BUỘC:

- Append/read conversation.
- 4 Agent conversation isolation.
- Index lookup.
- Restart/reload.
- Replay/reconnect.
- Duplicate protection.
- Streaming không tạo delta records trong SQLite.
- Completion persistence.
- Migration dữ liệu hiện có.
- History API regression.
- Communication regression.
- NF-149 / NF-150A / NF-150B regression.
- Lint
- Typecheck
- Schema validation
- Web build
- git diff --check

BROWSER:

- Chat bình thường.
- Real Agent streaming.
- Refresh vẫn đọc được conversation.
- Restart Node vẫn đọc được conversation.
- History vẫn hoạt động.
- Không thấy thay đổi behavior của chat ngoài storage.

Không thay đổi UI trong ticket này.
Không thay đổi Agent Gateway.
Không thay đổi Secret Backend.
Không commit ARCHITECTURE.md, sprints/, .DS_Store.

Chỉ commit thay đổi thuộc NF-154.

Commit:
NF-154 PASS: add File-Backed Conversation Storage
# Kế hoạch tách Control API bootstrap

## Bối cảnh

`backend/scripts/start-control-api.mjs` hiện khởi tạo quá nhiều dependency trong cùng một file:
database, event bus, agent gateway, code index, Stage-1 runner, dashboard, HTTP API và process lifecycle.
Điều này làm file khó đọc, khó kiểm thử và dễ tạo wiring sai giữa pipeline mới và phần legacy.

## Phạm vi tách

Chỉ tách phần bootstrap/khởi tạo dependency. Logic nghiệp vụ ticket vẫn giữ trong
`stage1-ticket-runner.js`; không tạo thêm pipeline thứ hai.

1. `backend/src/bootstrap/control-runtime.js`
   - Database, stores, event bus và protocol storage.
2. `backend/src/bootstrap/agent-services.js`
   - Agent profiles, secrets, configuration, gateway và agent settings.
3. `backend/src/bootstrap/index-services.js`
   - Index database, code search, file graph, relevant tree và context engine.
4. `backend/src/bootstrap/stage1-services.js`
   - Request builder, verification gate, Stage-1 ticket runner và tool registry.
5. `backend/src/bootstrap/http-services.js`
   - Chat, dashboard, sprint, decision services và HTTP API.
6. `backend/src/bootstrap/control-shutdown.js`
   - Đóng database, giải phóng process lock và xử lý `SIGINT`/`SIGTERM`.

## Thứ tự triển khai an toàn

1. Tách shutdown trước, không đổi hành vi runtime.
2. Tách agent services và index services.
3. Tách Stage-1 services.
4. Tách HTTP wiring cuối cùng.
5. Sau mỗi bước chạy backend lint, typecheck, syntax check và `git diff --check`.

## Nguyên tắc giữ nguyên

- `/ticket <id>` chỉ đi qua `stage1TicketRunner` và `stage1AgentTools`.
- Không khôi phục `agent_tool`, `dispatchChange` hoặc direct coding flow vào bootstrap mới.
- Helper chỉ tạo và nối dependency; không chứa logic xử lý ticket.
- Giữ runtime service nền và architecture chat/SSE vì các API hiện tại vẫn sử dụng chúng.
- Thực hiện từng bước nhỏ để dễ rollback và không đụng các thay đổi đang có trong worktree.

## Tiêu chí hoàn tất

- `start-control-api.mjs` chỉ còn load environment, tạo runtime, tạo services, listen và shutdown.
- Không còn wiring ticket legacy trong Control API.
- Các test Stage-1, dashboard và HTTP routing hiện tại vẫn pass.

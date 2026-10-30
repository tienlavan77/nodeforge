<!-- Báo cáo triển khai và kiểm chứng quyền sở hữu Coder trong Ticket Supervisor. -->
# Báo cáo triển khai Agent Occupancy / Ticket Supervisor

Ngày: 2026-09-28

Kế hoạch đối chiếu: `workflows/plan-agent-occupancy-ticket-supervisor.md`

Trạng thái nghiệm thu: **ACTIVE — chưa đóng kế hoạch**.

## Kết quả triển khai

- `agent-occupancy-store.js` lưu claim theo Coder, ticket và Supervisor trong SQLite. Claim và trạng thái profile `ready → working` được ghi trong cùng transaction; release kiểm tra `claim_id`, ticket và Supervisor, đồng thời ghi lý do. Hai ticket không thể cùng giữ một Coder; retry của đúng chủ sở hữu nhận lại claim cũ.
- Agent Profile Store giữ `working` khi profile đang có claim và từ chối xóa profile đó. Resolver tải lại profile trước khi chọn Coder hoặc Reviewer để giảm phụ thuộc vào snapshot cũ.
- Supervisor claim Coder trước khi enqueue. Claim được giữ khi verification thất bại, Reviewer yêu cầu sửa, Coder sửa và Reviewer đọc lại. Verdict `approved` hợp lệ mới chuyển ticket sang `COMPLETED` và release với lý do `accepted`.
- Reviewer đọc bằng chứng source qua Forge File Service, giới hạn 12 file, 64 KB/file và 200 KB tổng. Chỉ verdict JSON có cấu trúc được chấp nhận; source được kiểm tra checksum lần nữa trước khi duyệt. Thiếu Reviewer, bằng chứng hoặc vượt số lượt sửa sẽ chuyển `NEEDS_HUMAN_REVIEW` và ghi lý do terminal.
- Runtime lưu kết quả review để phát lại sau restart, giải phóng claim còn sót ở Supervisor đã terminal và đưa ticket có checkpoint hoàn tất nhưng review bị gián đoạn sang `needs_human_review`.
- Review được dispatch bằng job `operation: review` trong queue `agent.request`; runtime chuyển các job từ queue `review.request` cũ khi recovery. Không còn poller review riêng.
- Reviewer nhận patch Git giới hạn theo các file thay đổi từ commit nền của ticket, cùng source hiện tại qua File Service. File mới chưa được Git theo dõi vẫn có source đầy đủ trong bằng chứng review.
- `agent.status_changed` phát từ chuyển trạng thái đã persist; Node client nhận event trực tiếp và thẻ Agents dùng trạng thái này, đồng bộ lại từ API khi reconnect.
- Nhánh nghiệm thu release với `accepted`. Nhánh lỗi/escalation terminal release với lý do được ghi; lỗi có checkpoint còn resume giữ `WORKING`. Chi tiết từng nhánh nằm trong bảng terminal policy của kế hoạch.
- Yêu cầu **Code trực tiếp** và tool lab dùng chính sách terminal riêng: release sau khi lượt code/tool lab hoàn tất. Lỗi còn checkpoint có thể resume thì giữ claim.

## Bằng chứng kiểm tra

| Kiểm tra | Kết quả |
| --- | --- |
| Test trọng tâm cho occupancy, Supervisor, review, recovery, Git evidence, Node stream và Code trực tiếp | **43/43 pass** |
| `pnpm typecheck` | Pass |
| `pnpm validate:schemas` | Pass: 97 schema, 91 fixture |
| ESLint trên các file occupancy/review và test mới | Pass |
| ESLint mở rộng gồm `start-control-api.mjs` và `sender-worker.js` | Fail: 16 lỗi `no-unused-vars` trong hai file này |
| `git diff --check` | Pass |
| `pnpm lint` toàn repo | Fail: 39 lỗi; 16 lỗi ở `start-control-api.mjs`/`sender-worker.js`, 23 lỗi ở các file khác |

Test đã kiểm tra hai ticket tranh một Coder, hai Coder phục vụ hai ticket, claim sống qua restart, release đúng chủ sở hữu, Reviewer từ chối → Coder sửa → Reviewer duyệt, verdict sai và source đổi trong lúc review, phát lại verdict sau restart, cũng như nhánh không có Coder READY. Fixture Git thật kiểm tra patch của thay đổi đã commit và source của file mới chưa được theo dõi. Test Sender Worker xác nhận dispatch job review qua `agent.request`.

Lệnh tái lập nhóm 43 test: từ `backend/`, chạy `node --test tests/integration/review-evidence.test.js tests/integration/agent-occupancy.test.js tests/unit/review-request-handler.test.js tests/unit/review-worker.test.js tests/unit/supervisor-loop.test.js tests/unit/supervisor-execution.test.js tests/unit/direct-code-supervisor.test.js tests/unit/git-service.test.js tests/unit/next-node-client-stream.test.js`. Các gate khác chạy từ root bằng `pnpm typecheck`, `pnpm validate:schemas`, `pnpm lint` và `git diff --check`.

## Điểm chưa đạt để nghiệm thu toàn bộ kế hoạch

1. Chưa chạy E2E với Coder và Reviewer SDK thật, Control API và Agents UI đang mở. Các test review dùng gateway giả lập; do đó chưa có bằng chứng toàn chuỗi event → card live → reload/reconnect với agent thật.
2. Fixture Git chứng minh review nhận thay đổi đã commit và file mới; chưa có E2E SDK thật chứng minh Reviewer xử lý mọi loại thay đổi và đủ ngữ cảnh verification của ticket thực tế.
3. Lint toàn repo fail 39 lỗi. Trong đó 14 lỗi `no-unused-vars` ở `start-control-api.mjs`, 2 lỗi cùng loại ở `sender-worker.js`; 23 lỗi còn lại nằm ở các file khác, gồm lỗi parse và quy tắc lint khác. ESLint trên các file occupancy/review mới pass. Cần xử lý hoặc phân định gate lint của các file ngoài phạm vi trước khi đóng nghiệm thu.

**Đánh giá:** queue review đã được gộp, terminal policy đã được ghi rõ, event trạng thái chỉ còn nguồn từ occupancy store và review có bằng chứng Git/source. Chưa đánh dấu hoàn tất kế hoạch vì chưa có E2E SDK thật cùng Control API và Agents UI.

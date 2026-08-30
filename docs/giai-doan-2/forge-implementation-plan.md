# Kế hoạch triển khai — Forge Node↔Agent Protocol

> File này là kế hoạch sống — cập nhật trực tiếp vào đây khi có thay đổi, không tạo file mới cho mỗi lần chỉnh sửa.
> Xem chi tiết thiết kế schema/luồng đầy đủ tại `forge-node-agent-protocol.md`.

**Nguyên tắc chỉ đạo:** xây 1 đường đi trọn vẹn (happy path) cho 1 ticket đơn giản trước, thêm guard sau, thêm multi-agent sau cùng. Không làm đúng toàn bộ schema/guard ngay từ đầu — sửa sau khi có dữ liệu chạy thật rẻ hơn đoán trước.

---

## Giai đoạn 0 — Nền tảng

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 0a-1 | `envelope.schema.json` (request_id, parent_id, type, role, payload, timestamp) | ✅ Đã có | Envelope đã có đủ field bắt buộc; discriminator route theo `type`+`role` vẫn thuộc 0a-4. |
| 0a-2 | Schema payload chiều **Node → Agent** | ◐ Một phần | Đã có canonical `request.schema.json` và projection OAI/Anthropic; chưa nối vào live request builder. |
| 0a-3 | Schema payload chiều **Agent → Node**, tách theo từng `type` | ◐ Một phần | Đã có đủ 6 payload schema và registry role:type (gồm `no_wiring_needed`); chưa nối registry vào validator/discriminator chung. |
| 0a-4 | Hàm `validate(envelope)` — route theo `type`+`role` tới đúng schema con | ◐ Một phần | Đã có `validateEnvelope`/`assertValidEnvelope` validate envelope + payload theo `role:type`, và `options.state` tùy chọn. Chưa nối validator vào toàn bộ runtime và chưa có state-machine transition rules (bổ sung sau 1d). |
| 0b | Storage layer: `save(ref, data)` / `get(ref)` | ☐ Chưa làm | Tạm dùng file JSON hoặc SQLite, chưa cần DB phức tạp. |
| 0c | Git wrapper: `createBranch`, `commit`, `merge`, `discardBranch` | ☐ Chưa làm | Bọc `simple-git` hoặc gọi CLI trực tiếp. |
| 0d | Ticket store: nơi lưu trạng thái từng ticket (`blocked/in_progress/done`) | ☐ Chưa làm | Cần có trước khi làm guard "Check dependencies" ở Giai đoạn 1. |
| 0e | Adapter cho **1 provider duy nhất** | ☐ Chưa làm | Chọn provider dùng nhiều nhất trước; chưa generic hoá đa provider ở bước này. |

---

## Giai đoạn 1 — Happy path (không guard nặng, không retry)

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 1a | Guard **[5] Check dependencies** | ☐ Chưa làm | Cần 0d xong trước. Logic đơn giản: ticket có `dependencies` chưa `done` → `blocked`, dừng. |
| 1b | **Nhận ticket → chọn agent → build request đúng schema** | ◐ Một phần | Agent profile/provider được đọc ở runtime, nhưng đường gửi thật vẫn còn payload legacy `{ text, task }`; chưa build/validate canonical envelope trước khi gửi. |
| 1c | **Tạo git branch trước khi patch** | ☐ Chưa làm | Gọi `git.createBranch('task/<ticket_id>')` (dùng hàm wrapper đã viết ở 0c) ngay sau khi ticket qua guard dependency (1a), trước khi patch file đầu tiên. Ở giai đoạn này CHƯA cần merge/rollback tự động (đó là 4a) — chỉ cần patch luôn nằm trên branch riêng, không đụng `main` trực tiếp, dù còn thủ công merge bằng tay sau khi xem kết quả. |
| 1d | State machine tối giản: `task → code_needed → code_provide → code_response → patch` | ☐ Chưa làm | Bỏ qua `usage_query`, `status_check` ở bước này — patch xong thì dừng. |
| 1e | Hard-code 1 ticket đơn giản để test | ☐ Chưa làm | Mục tiêu: thấy code thật do agent tạo, ghi vào file thật, chạy end-to-end 1 lần. |
| 1f | Mock response agent để test state machine trước khi gọi API thật | ☐ Chưa làm | Tách lỗi "logic điều phối sai" khỏi lỗi "agent trả lời sai" — 2 loại dễ lẫn nếu test chung. |
| 1g | **Logging tuần tự cho mỗi bước trong chu trình** | ☐ Chưa làm | Ghi log có cấu trúc (không phải console.log tự do) tại mỗi lần chuyển bước: `{ timestamp, task_id, step_id, type, role, request_id, parent_id, duration_ms, status }`. Ghi cả lúc gửi request lẫn lúc nhận response. Mục đích: đọc lại được toàn bộ trình tự 1 task đã đi qua mà không cần lục transcript_blocks trong storage — log là góc nhìn "theo dõi vận hành", storage/transcript là góc nhìn "nội dung để agent dùng lại". 2 thứ khác mục đích, không dùng chung 1 nơi lưu. |

---

## Giai đoạn 2 — Khép vòng lặp 9 bước đầy đủ

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 2a | Thêm `usage_query` / `usage_needed` / `no_wiring_needed` | ☐ Chưa làm | |
| 2b | Thêm `status_check` / `completed` / `continue` | ☐ Chưa làm | `acceptance_criteria` gửi cho agent phải lọc theo phạm vi role (xem Giai đoạn 7). |
| 2c | Dependency graph đơn giản (parse import/require) | ☐ Chưa làm | Bắt đầu bằng regex/AST cơ bản, chưa cần hoàn hảo. |
| 2d | Code index | ☐ Chưa làm | Bắt đầu bằng keyword search/grep, chưa cần embedding. |

---

## Giai đoạn 3 — Guard rẻ, ROI cao

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 3a | Guard **[3] Round counter** | ☐ Chưa làm | Đếm tổng round theo `task_id` (không phải per-file), vượt ngưỡng → `needs_human_review`. |
| 3b | Guard **[4] Protected path** | ☐ Chưa làm | Danh sách regex chặn (`.env`, `wp-config.php`, `.git/`...) — chặn cả đọc lẫn ghi. |

---

## Giai đoạn 4 — Guard nặng, cần hạ tầng

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 4a | Guard **[2] Git branch/rollback** đầy đủ | ☐ Chưa làm | Commit từng round, merge cuối khi verify pass, xử lý merge conflict (dừng, báo owner — không tự resolve). |
| 4b | Guard **[1] Verify — tầng 1+2** (syntax + build) | ☐ Chưa làm | ROI cao nhất trong 3 tầng verify, nên làm trước tầng 3. |
| 4c | Guard **[1] Verify — tầng 3** (test hành vi, vd Puppeteer) | ☐ Để sau | Chỉ làm nếu thực sự cần cho loại ticket UI/visual lặp lại nhiều. |

---

## Giai đoạn 5 — Format code nâng cao

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 5a | Chỉ hỗ trợ `format: full` | ✅ Đã có | Runtime/schema hỗ trợ full-file (`full_file`) cho file mới và retry an toàn. |
| 5b | Thêm `unified_diff` | ✅ Đã có | Có schema guard và dispatch unified diff; bare/invalid hunk bị từ chối. |
| 5c | Thêm `patch` (structured operations) | ✅ Đã có | Có `apply_patch` handler riêng và routing theo format. |
| 5d | Escalation tự động: fail `unified_diff` ≥2 lần → ép `full` | ◐ Một phần | Đã có retry/path-format logic trong runtime; cần test xác nhận bộ đếm liên tiếp và ép full đúng ngưỡng. |

---

## Giai đoạn 6 — Report & thông báo owner

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 6a | Guard **[6]**: ghi report ra `reports/<task_id>.md` | ☐ Chưa làm | Đơn giản nhất, đủ dùng ban đầu. |
| 6b | Nâng cấp: webhook/Slack | ☐ Để sau | Chỉ làm nếu cần chủ động báo hơn là tự vào xem file. |

---

## Giai đoạn 7 — Multi-agent (Coder / Tester / Reviewer)

> Chỉ bắt đầu **sau khi Giai đoạn 1–6 chạy ổn định cho Coder một mình**.

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 7a | Lọc `acceptance_criteria` theo `agent_role` trước khi đưa vào `status_check` | ☐ Chưa làm | Không gửi tiêu chí thuộc phạm vi Tester/Reviewer cho Coder. |
| 7b | Thêm Tester agent | ☐ Chưa làm | Làm trước Reviewer — đơn giản hơn (chỉ sinh test, không ra verdict). |
| 7c | Thêm Reviewer agent | ☐ Chưa làm | Verdict: `approve` / `request_changes` (đẩy lại Coder) / `reject` (dừng, cần người). |
| 7d | File lock hoặc serialize theo dependency graph khi 2 agent cùng đụng 1 file | ☐ Chưa làm | Tránh race condition khi chạy nhiều agent. |

---

## Giai đoạn 8 — Để sau cùng (chỉ làm khi có tín hiệu thật)

| # | Việc | Ghi chú |
|---|---|---|
| 8a | Timeout streaming (idle timeout) hoặc timeout theo `complexity_hint` | Idle timeout ưu tiên nếu adapter hỗ trợ streaming — tránh cắt oan model đang suy luận lâu nhưng hợp lệ. |
| 8b | Ngân sách token/cost per task | Cộng dồn token đã dùng, vượt ngưỡng dừng bất kể round count còn dư. |
| 8c | Phòng chống prompt injection từ nội dung file | Luôn coi nội dung file là *data*, không phải *instruction*. |
| 8d | Verify sau khi merge để bắt semantic conflict giữa các task song song | Git merge sạch về text không đảm bảo logic không vỡ. |
| 8e | Planner agent — chuẩn hoá ticket từ mô tả thô | Luôn cần người xác nhận `acceptance_criteria` trước khi vào chu trình chính. |

---

## Nhật ký cập nhật

- 2026-08-30: Tạo kế hoạch lần đầu, sau khi chốt xong thiết kế schema/guard trong `forge-node-agent-protocol.md`.
- 2026-08-30: Bổ sung 1b (Node nhận ticket → chọn agent → build request đúng schema, validate trước khi gửi) và 1f (logging tuần tự có cấu trúc cho mỗi bước — tách riêng khỏi transcript_blocks trong storage, vì 2 thứ phục vụ mục đích khác nhau: log để theo dõi vận hành, storage để agent dùng lại context).
- 2026-08-30: Đối chiếu lại tiến độ thực tế: đánh dấu 0a-1 đã có; 0a-2/0a-3 và 1b một phần; đánh dấu các format `full`, `unified_diff`, `apply_patch` đã có, escalation còn cần kiểm thử.

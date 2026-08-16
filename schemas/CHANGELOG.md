# Changelog: v1.1 → v1.2

Mỗi mục dưới đây tương ứng với một điểm thiếu/mâu thuẫn đã nêu khi review v1.1.

## 1. Thiếu Session Schema
- **Mới:** `schemas/project/session.schema.json`.
- Định nghĩa chính thức object Session (id, project_id, task_id, workflow_run_id, started_by,
  agents[], status, started_at/finished_at, summary). Trước đây `session_id` được tham chiếu ở
  khắp nơi nhưng không có schema nào mô tả bản thân nó.

## 2. Thiếu Build/Lint/Typecheck Result Schema
- **Mới:** `schemas/results/check-result.schema.json`.
- Một schema dùng chung cho `kind: build | lint | typecheck`, có `diagnostics[]` (severity,
  message, file, line, column, rule_id) — thay vì để `review-result.verification` chỉ có 4
  boolean không mang chi tiết.

## 3. Task.status và Workflow.states là hai nguồn sự thật lệch nhau
- **Sửa:** `schemas/project/task.schema.json`.
- Thêm `workflow_id`, `workflow_state` (string tự do, khớp với `workflow.states` của
  workflow tương ứng).
- Thu hẹp `status` thành enum thô, không phụ thuộc workflow:
  `pending / active / blocked / completed / failed / cancelled`.
- Thêm `blocked_reason`, `owner` (agent_id sở hữu logic cho `target_paths`, phục vụ concurrent
  modification ở mục 45 tài liệu gốc), `depends_on[]` (task phụ thuộc task khác).
- **Lưu ý breaking change:** enum `status` cũ (`pending/planning/building/testing/reviewing/
  blocked/completed/failed/cancelled`) đã bị thay thế. Nếu có dữ liệu v1.1 tồn tại, cần migrate
  giá trị cũ sang `workflow_state` và suy ra `status` thô tương ứng.

## 4. `core/event` vs `node/node-event`, `core/command` vs `node/node-command` trùng lặp và lệch enum
- **Sửa:** `schemas/core/event.schema.json`, `schemas/core/command.schema.json` — hợp nhất toàn
  bộ `type` từng có ở cả hai phía thành một enum duy nhất, đây là nguồn sự thật chung.
- **Sửa:** `schemas/node/node-event.schema.json`, `schemas/node/node-command.schema.json` — bỏ
  định nghĩa `type` riêng, dùng `allOf: [$ref core, {enum: [...subset...]}]`. Về mặt validate,
  giá trị `type` phải nằm trong **giao** của hai enum — tức luôn là tập con hợp lệ của core.
  Đã kiểm chứng: `node-event` từ chối `task.created` (loại event chỉ dành cho protocol
  Agent↔Node) và chấp nhận `index.updated`.
- Không còn khả năng hai file tự ý thêm một `type` mới mà bên kia không biết.

## 5. Event không truy vết ngược được Command đã sinh ra nó
- **Sửa:** `schemas/core/event.schema.json` — thêm `request_id` (nối event về command gốc) và
  `causation_id` (nối event về event khác đã trực tiếp gây ra nó, khi một event kéo theo event
  khác thay vì xuất phát từ command).

## 6. Không có Permission/ACL Schema chính thức
- **Mới:** `schemas/project/permission.schema.json`.
- role × path glob × access[] (read/write/create/delete/rename/execute) × effect (allow/deny) ×
  priority. Tách bạch rõ với Rule trong README: Permission = được phép hay không (tất định,
  đánh giá trước khi hành động chạy); Rule = tốt hay không (thường cần phán đoán).

## 7. AI Agent capabilities chỉ là mảng string phẳng, Node có structure còn AI thì không
- **Sửa:** `schemas/core/agent.schema.json` — thêm `capability_scopes` (optional) dùng
  `common.schema.json#/$defs/capability_scope`, một cấu trúc nhóm tổng quát (không cố định danh
  mục như `node-capability`) để bất kỳ agent role nào cũng khai báo được capability chi tiết theo
  nhóm nếu cần. `capabilities` (mảng string phẳng) vẫn giữ để tương thích ngược.

## 8. `severity` enum bị lặp lại y hệt ở 3 nơi
- **Sửa:** `schemas/core/common.schema.json` — thêm `$defs/severity`.
- `schemas/core/error.schema.json`, `schemas/project/rule.schema.json`,
  `schemas/results/review-result.schema.json` (`findings[].severity`) đều đổi sang
  `$ref: common.schema.json#/$defs/severity` thay vì định nghĩa lại.

## 9. `context.diff` là object mở, không có cấu trúc hunk
- **Sửa:** `schemas/core/common.schema.json` — thêm `$defs/diff` (files[] → hunks[] →
  old_start/old_lines/new_start/new_lines/lines[], kiểu unified-diff).
- `schemas/context/context.schema.json.diff` giờ là `anyOf: [null, $ref common#/diff, object mở
  (fallback tương thích ngược)]` — Reviewer có thể review chính xác theo dòng nếu Node gửi diff
  có cấu trúc, nhưng vẫn nhận được diff thô nếu Node chưa chuẩn hóa kịp.

## 10. Không có schema cho kết quả của history.query / session.query / state.query
- **Mới:** `schemas/node/node-query-result.schema.json` — request_id, project_id, kind
  (history/session/state), items[], total, next_cursor.

## 11. Rule.rule là free-text, không có điều kiện máy đọc được
- **Sửa:** `schemas/project/rule.schema.json` — thêm `condition` (object tùy chọn) +
  `condition_language` (jsonlogic/regex/glob/ast_query/custom). `rule` (text) vẫn bắt buộc, luôn
  là thứ Reviewer đọc; `condition` là tùy chọn để Node tự enforce mà không cần AI khi
  `enforcement` là `orchestrator`/`blocking`.
- Bonus: thêm `exceptions[]`, `source` (provenance), `created_at`/`updated_at`.

## Thay đổi phụ trợ (không nằm trong 11 điểm gốc, nhưng liên quan trực tiếp)
- `schemas/context/context.schema.json`: thêm `index_version`, `generated_at` — Context Pack giờ
  tự khai báo mình build trên snapshot Code Index nào.
- `schemas/project/project.schema.json`: thêm `default_workflow_id`, `created_at`.
- Tất cả file đã được validate bằng `jsonschema` (Draft 2020-12): tất cả 23 schema hợp lệ cú
  pháp, và tất cả ví dụ trong `examples/` (bao gồm 6 ví dụ mới: `task.json`, `rule.json`,
  `session.json`, `permission.json`, `check-result.json`, `event.json`) pass validate đối chiếu
  đúng schema tương ứng.

## Không thay đổi / cố ý để nguyên
- `schemas/results/test-result.schema.json` giữ nguyên cấu trúc riêng (không gộp vào
  `check-result`) vì test cần `tests.{total,passed,failed,skipped}` và `failures[]` — hình dạng
  khác hẳn build/lint/typecheck.
- `schemas/core/envelope.schema.json`, `schemas/node/node-state.schema.json`,
  `schemas/project/workflow.schema.json` không đổi — đã đủ tốt từ v1.1.
- `schemas/node/node-capability.schema.json` đã deprecated và delegate về canonical contract
  `core/agent.schema.json`; không còn boolean capability model riêng.

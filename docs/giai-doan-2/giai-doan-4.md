# Giai đoạn 4 — Guard nặng, cần hạ tầng

> Mục tiêu: chỉ merge code sau khi commit task đã qua verification. Mọi thao tác filesystem đi qua File Service; mọi thao tác Git đi qua Git Service. Merge conflict phải dừng và báo người dùng, không tự resolve.

## 4a — Git branch/rollback đầy đủ

### 4a-1. Lifecycle của task branch

```text
task bắt đầu
  -> tạo task/<ticket_id>
  -> submit thành công
  -> ghi file qua File Service
  -> commit round
  -> verify commit
  -> verify pass: merge vào branch đích
  -> verify fail: giữ branch để retry hoặc rollback khi được yêu cầu
```

- Mỗi submit round tạo một commit riêng.
- Không merge trước khi verify pass.
- Branch đích mặc định là branch lúc dispatch, thường `main` hoặc branch cấu hình.
- Agent không tự chạy Git; chỉ Git Service được thao tác Git.

### 4a-2. Mở rộng Git Service

File chính: `backend/src/infrastructure/git/git-service.js`.

Bổ sung hoặc xác nhận các API:

- `getHead()` và `getBranchHead(branch)`.
- `commit(message, { paths })` trả `sha` và danh sách paths.
- `merge(branch, { target, noFastForward })` hỗ trợ `--no-ff`.
- `abortMerge()` để hủy merge đang conflict.
- `resetTo(commit, { hard })` chỉ áp dụng trên task branch đã xác định.
- `diffBetween(base, head)` và `hasConflicts()`.
- `discardBranch(name)` giữ guard branch bảo vệ.

Khi merge conflict:

1. Phát hiện lỗi merge.
2. Gọi `abortMerge()`.
3. Không tự sửa conflict.
4. Trả lỗi `GIT_MERGE_CONFLICT`.
5. Chuyển runtime status sang `merge_conflict` hoặc `needs_human_review`.
6. Giữ task branch để người dùng kiểm tra.

### 4a-3. Lưu metadata branch

Khi `initTask()` tạo branch, lưu:

- `branch_name`
- `base_commit`
- `target_branch`
- `task_id`
- `created_at`

Metadata nằm trong runtime status/execution record, không sửa roadmap ticket.

### 4a-4. Tách commit round khỏi submit handler

Tách trách nhiệm thành:

- `applySubmission(...)`
- `commitRound(...)`
- `recordRoundCommit(...)`

Yêu cầu:

- Validate toàn bộ file trước khi ghi.
- Ghi toàn bộ file qua File Service rồi commit một lần cho round.
- Không tạo commit rỗng.
- Kết quả round phải có `commit_sha`.
- Nếu ghi thành công nhưng commit lỗi, giữ trạng thái lỗi rõ ràng.

### 4a-5. Rollback policy

- Patch lỗi trước khi ghi: không cần rollback Git.
- Verify fail: giữ commit trên task branch và gửi diagnostics cho Agent retry.
- Hủy task hoặc owner yêu cầu: mới reset/revert hoặc discard task branch.
- Merge conflict: abort merge, không reset branch đích, chuyển human review.
- Không tự động `git reset --hard` trên branch đích.

## 4b — Verify tầng 1 + 2

### 4b-1. Verification plan

Hạ tầng dùng lại:

- `backend/src/modules/verification/check-runner.js`
- `backend/src/modules/verification/orchestrator.js`
- `backend/src/application/test-service.js`
- `schemas/verification/verification-plan.schema.json`
- `schemas/verification/verification-result.schema.json`

Plan mặc định cho coding ticket:

```text
syntax -> lint -> typecheck -> build
```

- Syntax dùng `node --check` hoặc công cụ tương ứng theo language.
- Lint, typecheck, build được chọn theo project/scope.
- Command do Node chọn từ allowlist; Agent không tự cung cấp command.

### 4b-2. Build plan theo ticket

Plan dựa trên:

- `files_changed`
- `scope`
- `project_id`
- `commit_id`
- language của file
- project/package bị ảnh hưởng

Ticket chỉ sửa UI không bắt buộc chạy toàn bộ backend, nhưng build project bị ảnh hưởng vẫn phải chạy nếu acceptance criteria yêu cầu.

### 4b-3. Verification result policy

Kết quả phải có:

- `status`: `passed` hoặc `failed`.
- `ready_for_review`.
- `commit_id`, `run_id`, `breakdown`.
- diagnostics theo file/dòng nếu có.
- stdout/stderr được giới hạn kích thước.

Mapping:

- Tất cả check pass: `ready_for_review=true`.
- Một check fail hoặc timeout: không merge.
- Không có check hợp lệ: không được coi là pass.

### 4b-4. Retry sau verify fail

1. Lưu verification result vào Protocol Storage.
2. Giữ commit hiện tại trên task branch.
3. Tạo request mới với `parent_id`, `retry_of_step`, `previous_error` và checksum mới.
4. Agent sửa code.
5. Submit tạo commit round tiếp theo.
6. Verify lại.

Retry dùng chung round counter 3a, không tạo counter riêng cho verification.

## 4a + 4b — Verification gate và runner

Tạo lớp orchestration riêng, dự kiến `backend/src/modules/workflows/stage1-verification-gate.js`.

Trách nhiệm:

1. Nhận commit và `files_changed`.
2. Build verification plan.
3. Gọi Verification Orchestrator.
4. Nếu pass, gọi Git Service merge.
5. Nếu fail, lưu report và trả diagnostics để runner retry.
6. Nếu conflict, abort merge và chuyển `merge_conflict`/`needs_human_review`.

Runner không chứa logic command/build/merge chi tiết.

## 4c — Để sau

Chưa triển khai Puppeteer/browser behavior test. Chỉ mở khi ticket UI/visual lặp lại cần kiểm tra tương tác mà syntax/build không phát hiện được.

## Bộ test bắt buộc

### Git

- Tạo branch và lưu `base_commit`.
- Commit explicit paths, không commit rỗng.
- Mỗi round có commit riêng.
- Merge pass.
- Merge conflict được phát hiện và abort.
- Không tự resolve conflict.
- Không discard branch bảo vệ.
- Rollback chỉ tác động task branch.

### Verify

- Syntax/lint/typecheck/build pass và fail.
- Timeout.
- Diagnostics có file/dòng.
- Verify fail không merge.
- Verify pass mới merge.
- Retry nhận đúng `previous_error`.
- Không merge nhầm branch/commit.

### Integration

```text
initTask
  -> code_needed
  -> code_provide
  -> submit
  -> commit round 1
  -> verify fail
  -> retry Agent
  -> submit
  -> commit round 2
  -> verify pass
  -> merge
  -> done
```

Nhánh conflict:

```text
verify pass -> merge conflict -> abort merge -> merge_conflict/needs_human_review
```

## Thứ tự triển khai

1. Bổ sung Git Service primitives.
2. Test Git Service.
3. Tách commit round khỏi submit handler.
4. Lưu commit metadata từng round.
5. Viết verification plan builder.
6. Viết verification gate dùng Orchestrator hiện có.
7. Test syntax/lint/typecheck/build/timeout.
8. Nối verification gate vào Stage-1 runner.
9. Nối retry sau verification failure.
10. Nối merge sau verification pass.
11. Viết integration test toàn luồng.
12. Chạy backend tests, lint, typecheck, schema validation, Next build và `git diff --check`.

## Trạng thái

| Hạng mục | Trạng thái |
|---|---|
| 4a — Git branch/rollback | Đã có primitives và merge gate; conflict abort qua gate |
| 4b — Verify syntax + build | Đã có plan builder/gate và nối tùy chọn vào Stage-1 runner |
| 4c — Browser behavior test | Để sau |

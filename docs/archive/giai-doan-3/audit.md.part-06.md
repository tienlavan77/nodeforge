<!-- Preserves an ordered historical design section so repository restructuring retains the full technical discussion and can verify its original checksum after splitting. -->
- UUID connection-test route.
- Secret reference/masking.
- Schema-driven contracts.
- Roadmap/sprint/ticket/dashboard.
- SSE stream cơ bản.

### Đã làm nhưng chưa reconcile

- Profile schema với runtime projection.
- Provider enum giữa schema/service/adapter.
- UUID-only với legacy compatibility.
- Forge v1 router với direct routes trong server.
- `frontend/` với `ui/nextjs/`.
- Bootstrap abstraction với production runtime.
- Workflow definition với ruleset mặc định.
- Active schema với legacy schema/fixture.
- Root runtime database với backend runtime database.
- Migration role/nickname của agent.

### Chưa hoàn chỉnh

- UI CRUD agent đầy đủ.
- ThemeToggle, status row và theme synchronization.
- Authentication/login thực tế.
- Full test suite xanh.
- Strict UUID enforcement.
- Provider vocabulary chính thức.
- Ruleset mặc định.
- Xác định một frontend source duy nhất.
- Cô lập/xóa legacy API routes.
- API contract/error documentation hoàn chỉnh.
- Deployment/process verification tự động.

## 20. Các vấn đề ưu tiên

### P0 — Không làm mất thay đổi hiện có

Phân loại 151 modified và 96 untracked trước mọi cleanup hoặc commit. Tách runtime/generated files, feature changes, legacy files, temporary test scripts và tài liệu.

### P1 — Chốt agent contract

- Thêm `role` vào node configuration required/projected fields.
- Kiểm tra và sửa role của sprint leader.
- Chốt provider `anthropic`/`claude`/`devquote`.
- Cập nhật schema, service, adapter và fixtures đồng bộ.
- Enforce UUID nếu UUID là contract cuối cùng.
- Quyết định thời điểm bỏ legacy ID.

### P1 — Chốt frontend

Chọn `frontend/` hoặc `ui/nextjs/` làm source chính. Di chuyển API client/page/test về cùng một cấu trúc; không duy trì ba nguồn (`frontend`, `ui/nextjs`, `ui/dist`) như các nguồn cạnh tranh.

### P1 — Chốt API ownership

Một route chỉ nên có một implementation. Forge v1 router phải là owner của `/forge/v1`; direct/legacy handling trong `server.js` phải được xóa hoặc đánh dấu rõ boundary.

### P1 — Sửa contract/test drift

Khôi phục hoặc tạo đúng ruleset mặc định; cập nhật test path frontend; làm deterministic tool tests không phụ thuộc agent ngẫu nhiên/provider bên ngoài.

### P2 — Hardening runtime

- xác nhận cwd/dataDir/database path trong startup log;
- kiểm tra restart/recovery nhiều task;
- kiểm tra duplicate request/event;
- kiểm tra VP/iVP và repair loop;
- kiểm tra provider error/timeout/retry;
- kiểm tra security policy trên mọi execution handler.

## 21. Thứ tự triển khai đề nghị

### Giai đoạn A — Baseline

1. Phân loại toàn bộ git diff/untracked.
2. Xác định generated/runtime và file cần track.
3. Chọn frontend chính.
4. Chọn provider vocabulary.
5. Xác định process/database path chuẩn.

### Giai đoạn B — Agent contract

1. Chốt schema profile.
2. Chốt UUID/legacy policy.
3. Đồng bộ profile store, service, projection và API.
4. Migrate/validate database.
5. Cập nhật fixtures.
6. Test CRUD và connection test.

### Giai đoạn C — Runtime pipeline

1. Kiểm tra composition root.
2. Kiểm tra supervisor recovery.
3. Kiểm tra durable queue/idempotency.
4. Kiểm tra materializer VP/iVP.
5. Kiểm tra verification/repair.
6. Kiểm tra event correlation.

### Giai đoạn D — Provider

1. Chốt canonical request.
2. Test Anthropic/Claude mapping.
3. Test OpenAI mapping.
4. Test Codex/Devquote/custom.
5. Test forced `code_needed` tool call.
6. Test transcript/cache/usage/error.

### Giai đoạn E — API

1. Chốt route Forge v1.
2. Cô lập legacy routes.
3. Đồng nhất service validation.
4. Chuẩn hóa error/status code.
5. Test local/LAN/restart.

### Giai đoạn F — UI

1. Chọn frontend source.
2. Nối agent API client.
3. Implement list/create/edit/delete/test connection.
4. Implement status row.
5. Implement ThemeToggle và persistence/synchronization.
6. Chạy Next build và browser test.

### Giai đoạn G — Verification cuối

```bash
npm run validate:schemas
npm run lint
npm run typecheck
npm test
```

Sau đó chạy backend smoke test, API smoke test, UI build/browser test và `git diff --check`.

## 22. Kết luận

NodeForge đã có phần lớn nền tảng của một orchestrator multi-agent thực tế: profile, gateway, provider pipeline, protocol state, queue, supervisor, materializer, verification, repair, event/history, code index, schema và Forge v1 API.

Trạng thái hiện tại là **nhiều subsystem đã được triển khai nhưng baseline chưa được reconcile hoàn toàn**. Các điểm load-bearing cần xử lý trước khi mở rộng tính năng là:

1. Đồng nhất agent profile contract giữa schema, database, service và runtime projection.
2. Chọn một frontend source và một API route owner.
3. Chốt provider vocabulary.
4. Khôi phục ruleset và cập nhật test/fixture drift.
5. Phân loại working tree trước khi tiếp tục sửa hoặc commit.

UUID connection-test route hiện hoạt động live; full repository vẫn chưa xanh vì còn 12 test failure và các inconsistency nêu trên.

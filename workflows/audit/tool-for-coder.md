# Audit: Bộ tool cung cấp cho Coder

- **Ngày ghi báo cáo:** 2026-10-09.
- **Phạm vi:** tool được expose trong đường Supervisor thực thi ticket, quyền truy cập, verification, commit và provider routing.
- **Nguồn:** kết quả điều tra source/test được trình bày trong lượt trao đổi trước. Lượt ghi báo cáo này không đọc lại source hoặc xác minh checksum của các evidence bên dưới; số dòng là tham chiếu từ lần điều tra trước, cần đối chiếu lại khi review.
- **Trạng thái:** audit findings phục vụ review, không phải verdict implementation độc lập, Architecture Plan hay Sprint Plan được duyệt.

## 1. Kết luận

Theo kết quả điều tra trước, Claude và Codex có bộ Forge tool thực thi ticket, nhưng còn điểm lệch giữa tool, rulebook và test. Chưa đủ evidence để coi luồng Coder đã hoàn chỉnh.

Các điểm cần làm rõ trước acceptance gồm: vòng trả lời Reviewer, verification coverage, nguồn authorization cho commit và năng lực implementation theo provider.

## 2. Tool được cung cấp

Trong đường Supervisor thực thi ticket đã khảo sát:

| Chức năng | Claude Coder | Codex Coder |
| --- | --- | --- |
| Tìm theo code index | `search_code` | `search_code` |
| Metadata, symbol map, checksum | `read_file` | `read_file` |
| Danh sách file | `Glob` | `rg_files` |
| Tìm nội dung | `Grep` | `rg_search` |
| Đọc source | `Read` | `sed_lines` |
| Ghi/sửa với checksum | `write_diff`, `edit_diff` | `write_diff`, `edit_diff` |
| Verification do Node quản lý | `run_test`, `check_test` | `run_test`, `check_test` |
| Xem Git | `git_status`, `git_diff` | `git_status`, `git_diff` |
| Commit | `commit_changes` | `commit_changes` |
| Báo hoàn tất | `report_done` | `report_done` |

### Giới hạn và khác biệt

- `Read/Glob/Grep` của Claude là Forge MCP wrappers, không phải native filesystem tools; native tools bị tắt trong `createClaudeForgeOptions`.
- Hai executor đã khảo sát không cấp `select_code_graph_candidates` cho Coder.
- `read_file` của Coder trả metadata; đọc source dùng `Read` hoặc `sed_lines`, tối đa 80 dòng/lần. Không suy rộng mô tả này sang tool của Architecture.
- `respond_to_review` có implementation trong registry nhưng chưa được expose trong hai executor đã kiểm tra.

**Evidence được ghi nhận:**

- `backend/src/modules/supervisor/nodeforge-task-executors.js:18–67,84–144`
- `backend/src/tools/claude-sdk-forge-tools.js:73–140`
- `backend/src/tools/claude-file-tools.js:13–40`

## 3. Quyền sử dụng và boundary

Danh sách tool không đồng nghĩa quyền thao tác không giới hạn. Kết quả điều tra trước ghi nhận:

- Capability và `task_id` do Node cấp.
- Scope theo `allowed_file_paths` / `allowed_prefixes`; khi có immutable manifest, scope lấy từ manifest.
- Coder bị chặn `docs/` kể cả allowlist cũ có chứa đường dẫn này.
- Workflow instructions được đọc nhưng không được Coder sửa.
- Commit lấy paths từ ticket ledger; paths tự truyền phải khớp ledger.

**Evidence được ghi nhận:** `tool-authorization.js:5–32`, `agent-verification-tools.js:39–66`, `file-service-role-policy.js` và cấu hình scope trong hai executor. Một số tham chiếu chưa có đường dẫn đầy đủ/số dòng; cần bổ sung khi xác minh lại.

## 4. Findings

### F1 — Major: vòng trả lời Reviewer chưa nối đủ

**Quan sát:** Claude và Codex chưa được cấp `respond_to_review` trong hai executor, trong khi integration có xử lý kết quả từ tool này. Test Codex vẫn kỳ vọng danh sách có `respond_to_review`, khác source đã khảo sát.

**Tác động:** chưa chứng minh Coder có thể hoàn thành vòng giải trình/dispute qua đường executor này. Không kết luận mọi đường runtime đều thiếu khả năng đó.

**Cần xác minh:** expose thực tế theo provider, authorization và một vòng review/response end-to-end; đồng bộ test với contract được chốt.

**Evidence:** `nodeforge-task-executors.js:49,54,115`; `nodeforge-task-integration.js:157–159`; `codex-sdk-supervisor-forge-mcp.test.js:67`.

### F2 — Major: không được hiểu `run_test PASS` là coverage toàn ticket

**Quan sát:** `run_test` không nhận command tùy chọn. Logic mặc định đã đọc:

- Không có thay đổi Next.js: chạy `backend/tests/tools/*.test.js`.
- Có thay đổi Next.js: chạy các file test UI đã thay đổi, nếu có, rồi build.

**Tác động:** backend business logic có thể chưa được kiểm tra bởi bộ unit/integration liên quan. PASS của lệnh này chưa tự chứng minh acceptance criteria toàn ticket.

**Cần xác minh:** verification service của workspace, test selection thực tế và mapping acceptance criteria tới evidence trước khi kết luận coverage cuối cùng.

**Evidence:** `backend/src/tools/agent-verification-tools.js:10–25`.

### F3 — Major: rulebook và nguồn quyền commit chưa thống nhất rõ

**Quan sát:** rulebook nói không commit nếu chưa được yêu cầu rõ; executor vẫn cấp `commit_changes`.

**Tác động:** cấp capability chưa tự chứng minh ticket/human đã cho phép commit. Chưa có evidence trong báo cáo này để kết luận runtime cho phép commit trái phép.

**Cần chốt:** nguồn authorization cho commit, nơi thể hiện trong ticket/UI và cơ chế enforce trước thao tác.

**Evidence:** `workflows/agents/coder/README.md:15`; capabilities tại hai executor.

### F4 — Lỗi source có điều kiện: dùng biến trước khởi tạo

**Quan sát:** hai executor tính `candidateDiscoveryEnabled` với `immutableScope` trước khi khai báo biến đó.

**Điều kiện:** với `selected.role === "coder"`, biểu thức short-circuit nên không gây lỗi này. Với role khác và không phải direct-code, nhánh đó có thể phát sinh `ReferenceError`.

**Cần xác minh:** khả năng đi vào nhánh liên quan và regression test trước khi kết luận tác động runtime. Không ghi nhận đây là lỗi đã tái hiện trên session Coder.

**Evidence:** `nodeforge-task-executors.js:25–27,91–93`.

## 5. Provider không đồng nghĩa năng lực implementation

Theo executor đã khảo sát:

- Claude/Anthropic và Codex có đường thực thi coding.
- OpenAI-family và Ollama đang có đường greeting, không phải implementation ticket trong executor này.
- Direct-code selector chỉ chọn `codex`, `claude`, `anthropic`.

Không suy rộng kết luận này thành đánh giá năng lực chung của các provider hoặc mọi đường chạy khác trong hệ thống.

**Evidence:** `nodeforge-task-executors.js:70–81`; `ticket-agent-provider-routing.js:46–66`.

## 6. Hàm ý cho trang Coding — đề xuất, chưa phải quyết định đã duyệt

Trang Coding cần giúp human phân biệt:

1. Provider có hỗ trợ implementation trong đường thực thi đang chọn hay không.
2. Tool thực sự được expose, thay vì chỉ danh sách capability danh nghĩa.
3. Scope/immutable manifest và giới hạn đọc, ghi.
4. Nguồn quyền commit; capability không thay thế authorization.
5. Verification đã chạy, coverage và phần còn chưa chứng minh; không chỉ chữ PASS.
6. Khả năng hoàn tất vòng review/response theo provider.

Các đề xuất này chưa tạo quyền sửa source, mở scope, dispatch, commit hoặc rollout.

## 7. Handoff và verification còn mở

| Nội dung | Trách nhiệm đề xuất | Evidence cần bổ sung |
| --- | --- | --- |
| Đối chiếu source/index/hash hiện tại và expose tool | SL tổ chức discovery, phân công owner | Đường dẫn đầy đủ, checksum, cấu hình theo provider |
| Vòng review/response | SL phân rã delivery; Reviewer kết luận độc lập | Test và runtime evidence cho vòng phản hồi |
| Verification coverage | SL xác lập coverage/owner | Mapping criterion → test/run evidence, giới hạn coverage |
| Authorization commit | Architecture/human chốt boundary nếu cần; SL triển khai trong boundary | Contract quyền commit và test enforce |
| Nhánh dùng biến trước khởi tạo | SL phân công xác minh; Reviewer kiểm tra | Regression test và điều kiện reachability |
| Hiển thị trên Coding | Human/Architecture chốt outcomes; SL lập SP | UI evidence nhất quán với runtime authority |

Chưa xác nhận người nhận việc, ETA, Sprint Plan hoặc approval. SL sở hữu phân rã ticket, coverage, dependencies, owner, ETA và blocker; Architecture xử lý quyết định vượt boundary; Reviewer kết luận implementation độc lập.

## 8. Giới hạn của báo cáo

- Nội dung source-specific được lưu từ kết quả điều tra đã nêu trong hội thoại; chưa tái xác minh trong lượt ghi tài liệu này.
- Chưa chạy test, đối chiếu raw run evidence hoặc xác minh session runtime.
- Chưa sửa source, tạo SP runtime, dispatch agent, commit/push hoặc rollout.
- Việc ghi báo cáo không đóng các findings hay các gates recovery/full cutover đang mở.

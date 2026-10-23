<!-- Báo cáo triển khai catalog Forge dùng chung cho Coder, bằng chứng kiểm chứng và các gate chưa được đóng. -->
# Coder unified Forge tools — implementation report

Ngày triển khai ban đầu: 2026-10-09 (UTC). Cập nhật kiểm chứng: 2026-10-10 (UTC).

## 0. Focused recheck ngày 2026-10-10 — trạng thái mới nhất

Theo yêu cầu Human, đã chạy lại đúng focused eight-file command ở mục 2, một lần duy nhất; không chạy full suite.

- Run: `VERIFY-RUN-19dac120-f8ff-4de1-bf65-a332bdc88f13`.
- Evaluated: `2026-10-10T06:43:01.560Z`.
- Kết quả: **FAILED**, exit `1`, `ready_for_review: false`.
- Hai failures về thứ tự tools ở lần chạy trước không còn nằm trong danh sách failures trả về.
- Service trả về ba failures mới:
  1. `engineering-tool-binding.test.js:70`: `missing focused service and unimplemented action receipts never produce PASS, commit or push` — thiếu rejection `TOOL_LOCKED` được fixture kỳ vọng.
  2. `engineering-tool-binding.test.js:79`: `metadata-only Coder policy remains locked instead of silently granting canonical source windows` — readiness reason là `null`, không khớp `/policy approval/`.
  3. `engineering-tool-catalog.test.js:56`: `canonical aliases reuse the original governed executor rather than a second service or ledger` — wrapper mới không reference-equal với legacy tool object.

### Đối chiếu source hiện tại sau recheck

Catalog vẫn đúng identity của bản sửa thứ tự cuối: `e5fe540d7864e480c03fd2d1271e459ae3a4f5f769e6b85f3b74de1e4e501ca1`.
Hai source đã khác identities của batch lịch sử ở mục 5:

- `engineering-tool-binding.js`: `f21a1875e87ed837e7ae9de4bf660f993a67974a6c6190f8767521dbf71f7774`. Binding hiện chỉ explicit-lock `run_check` và `push_commit`, không còn explicit-lock commit/read_file như mô tả batch ban đầu. Missing handlers được thay bằng `lockedTool` có execute, nên readiness có thể báo available dù executor từ chối. Không kết luận guard/service production đã an toàn chỉ từ fixture.
- `engineering-tool-implementations.js`: `8f019c30cd22150a7ab7a6d1ffcb1df291f2b90c9250ed7a49fc1e19bb737150`. Canonical aliases hiện dùng wrapper gọi legacy executor và thêm alias capability; không còn trả chính cùng tool object. Test reference equality chưa phản ánh implementation hiện tại, nhưng chưa chứng minh governance semantics tương đương.

Các reads này là individual source identities sau run, không phải manifest nguyên tử của lần verification.
Git status hiện có **17 files**: 11 modified tracked, 6 untracked; không staged/conflict. Ngoài batch ban đầu còn có thay đổi executor/prompts/SDK-events/resume/Claude adapter. Lượt này không tạo hoặc sửa các thay đổi implementation đó; giữ nguyên để không ghi đè công việc hiện hữu. Các mục 1–6 dưới đây là lịch sử batch 2026-10-09, không phải mô tả đầy đủ source mới nhất.

### Kết luận và phần còn lại

- Đã hoàn thành yêu cầu rerun; **chưa PASS, chưa nghiệm thu**.
- Lượt này chỉ kiểm chứng, đọc đối chiếu và cập nhật báo cáo; không sửa source/tests hoặc lặp check thứ hai.
- Cần đối chiếu contract/approval mới nhất trước sửa hai fixtures khóa quyền; không bỏ negative assertions đơn thuần để đạt PASS. Alias fixture cần kiểm tra delegation, issued capability và governance thay vì chỉ reference equality. Readiness phải khớp trạng thái thực của locked executor.
- Không có raw TAP/tổng số tests/Node version trong kết quả nhận được; không tự ghi số PASS hoặc Reviewer acceptance.
- Giữ nguyên kết quả FAILED lịch sử ở mục 2. Chưa commit/push, không RUN production hoặc rollout.

---
Plan: `workflows/plan-coder-unified-forge-tools.md`.
Trạng thái: **đã sửa code; chưa hoàn tất plan, chưa bật provider cutover, chưa nghiệm thu**.

## 1. Phạm vi và thay đổi thực tế

SM triển khai trực tiếp, không tạo Sprint/ticket hoặc dispatch SL/Coder/Supervisor production.
Chỉ dùng Forge để đọc, sửa, kiểm tra và xem Git. Không migration, rollout hay sửa database.

- Thêm `engineering-tool-catalog.js`: catalog `forge-engineering-v1`, đủ 12 tên engineering tool, schemas dùng chung, aliases schema-equivalent và trạng thái available/locked với lý do.
- Owner conversation lấy descriptors từ catalog chung; giữ nguyên owner role policy, các service handlers và conversation change ledger. Owner Coder vẫn chỉ có read/discovery, không nhận quyền System Engineer.
- Thêm `engineering-tool-implementations.js`, nối vào ticket registry: `list_files`, `search_text`, `read_lines` dùng lại executor đã govern của `rg_files`, `rg_search`, `sed_lines`; thêm tree reader lọc file và directory theo scope ticket.
- Bổ sung canonical discovery names vào governance budget và discovery-kind mapping; không tạo đường bỏ qua budget.
- Thêm `engineering-tool-binding.js`: Node-bound Coder context, schema validation, caller không được thay identity/root/capabilities/scope qua tham số execute; mutation bị giới hạn bởi immutable manifest; chặn docs, workflow writes, protected paths, traversal và symlink components.
- Binding là **nền tảng chưa nối vào routing SDK production**. Nó giữ lifecycle extensions `search_code`, `run_test`, `check_test`, `report_done`, `respond_to_review` và ba legacy discovery aliases; không dùng owner ledger.
- Binding khóa `read_file` canonical vì policy Coder hiện vẫn metadata-only; khóa commit/push vì chưa có action-grant receipt producer cho cutover. `run_check` không được alias thành `run_test/check_test` và bị khóa khi thiếu compatible scoped service.
- Coder provider admission chỉ chấp nhận transports hiện có Claude/Anthropic/Codex. OpenAI-compatible, Ollama hoặc provider không xác định bị chặn trước occupancy claim, enqueue và SDK launch; không trở thành greeting-only success. Review-resume không dispatch Coder nên không bị ép vào gate launch này.
- Thêm ba test files cho catalog/owner policy, bound authority/negative scope và provider admission trên submission path.

Không thay đổi `agent-lifecycle-tools.js`, không gỡ metadata-only guard, không chuyển Coder thành System Engineer, không cấp `project_wide_access`.
Adapter Claude đã được trả về nguyên trạng sau một sửa signature tạm thời; cuối batch không có diff cho adapter này.

## 2. Focused verification — kết quả lịch sử phải giữ nguyên

Đã thực hiện đúng một `run_check` trong lượt này:

```text
node --test backend/tests/unit/engineering-tool-catalog.test.js backend/tests/unit/engineering-tool-binding.test.js backend/tests/unit/engineering-provider-admission.test.js backend/tests/unit/owner-engineer-tools.test.js backend/tests/unit/owner-sdk-tools.test.js backend/tests/unit/ticket-agent-provider-routing.test.js backend/tests/unit/runtime-tool-governance.test.js backend/tests/unit/coder-path-permissions.test.js
```

- Run: `VERIFY-RUN-9b645305-ec8e-4cdc-b25f-a7597ce20c8b`.
- Evaluated: `2026-10-09T13:24:25.192Z`.
- Result: **FAILED**, exit `1`, `ready_for_review: false`.
- Service trả về hai failures trong `owner-sdk-tools.test.js`: thứ tự descriptors thay đổi, catalog đặt `run_check` trước `git_status/git_diff`, trong khi contract owner cũ yêu cầu nó nằm sau.
- Không có raw TAP, tổng số tests hoặc Node version trong kết quả trả về; không tự ghi số PASS hay independent acceptance.
- `changed_paths` của verification service chứa lịch sử conversation ledger, không phải danh sách thay đổi của batch hay source snapshot nguyên tử. Git status hiện chỉ có 12 source/test files thuộc batch này.

### Sửa sau FAIL

Đã chỉnh catalog và `ENGINEERING_TOOL_NAMES` về thứ tự owner tương thích:
`search_tree, list_files, search_text, read_file, read_lines, write_diff, edit_diff, git_status, git_diff, run_check, commit_changes, push_commit`.

**Bản sửa cuối chưa chạy lại. Không đổi kết quả FAILED thành PASS.**
Bước kiểm chứng tiếp theo: chạy lại chính focused eight-file command trên khi được cho phép thêm một lượt check.
Không chạy full suite, lint/build, SDK conformance live hoặc UI browser check.

## 3. Đối chiếu outcomes — không đóng vượt evidence

| Outcome | Batch hiện tại | Còn mở |
|---|---|---|
| O1 catalog | Có shared descriptors; owner và ticket registry foundations dùng chung | Routing/provider cutover chưa dùng bound catalog |
| O2 provider conformance | Admission chặn các greeting-only Coder paths | Claude/Codex canonical SDK round-trip; OpenAI/Ollama governed adapters chưa triển khai |
| O3 scope/security | Có bound-context validation, scope/manifest guards và negative fixtures | Bản cuối chưa recheck; current-ownership/lifecycle cross-process evidence chưa đủ |
| O4 verification evidence | Giữ riêng final verification extensions; focused service không được giả lập | Compatible ticket-focused run_check service và source-bound artifacts chưa triển khai |
| O5 lifecycle/resume | Có descriptors/extensions tương thích ở binding foundation; legacy routing không bị thay | Catalog checkpoint/version migration, end-to-end report_done/respond_to_review/resume conformance chưa đóng |
| O6 Coding runtime UI | Có readiness primitive với locked reasons | Chưa có Node readiness transport và Next.js runtime permissions UI |

Không có Reviewer độc lập hoặc evidence từ provider SDK thật trong batch này.

## 4. Forge security gates và quyết định cần xác nhận

Hai thao tác đã bị Forge từ chối; không dùng workaround để đạt cùng thay đổi bị chặn:

1. Sửa metadata-only guard của Coder bằng cách dựa vào catalog-version marker. Forge đánh giá marker chưa chứng minh provenance để mở quyền đọc source window. Guard cũ vẫn nguyên vẹn; canonical `read_file` của binding hiện bị khóa.
2. Cho adapter Claude thay fixed inventory bằng tùy ý `suppliedDefinitions` từ caller. Forge đánh giá đây là mở tool surface/schema không đủ authority. Thay đổi đã được rút lại; adapter không nhận schema override mới.

Để làm tiếp qua boundary này cần xác nhận rõ policy cho **Coder bounded-source read trong Node-issued scope**, và phương án adapter chỉ dùng **fixed Node-owned catalog/allowlist**, không schema tùy ý từ model/caller. Không cần mở project-wide access hoặc native shell/files/Git.
Các phần độc lập còn lại vẫn cần implementation và tests; các gate này không phải bằng chứng hoàn thành toàn bộ plan.

## 5. Individual source identities của bản hiện tại

Các SHA dưới đây là identities lấy từ Forge reads/edits riêng lẻ, **không phải manifest nguyên tử của verification run**. Catalog đã đổi sau lần FAILED.

| File | SHA-256 |
|---|---|
| backend/src/tools/engineering-tool-catalog.js | e5fe540d7864e480c03fd2d1271e459ae3a4f5f769e6b85f3b74de1e4e501ca1 |
| backend/src/tools/engineering-tool-binding.js | 388ad0fe7bcc8b93a19896cde21cd9c8148a357242400d8c0f37365b88280922 |
| backend/src/tools/engineering-tool-implementations.js | 32d68eaae7a8e990ce9668905512a9d15b8eb3c670ae5c5aec1bf72b38a7d793 |
| backend/src/tools/owner-conversation-tools.js | 42bacf001bb925ef03bcb0a0773ca91961dce9d6d306b4e6ec7e829e71edd74e |
| backend/src/tools/owner-engineer-tools.js | c95c98c732fb81e147857d1a1b199ac0bfdfd512f85238b9adad27a517e13855 |
| backend/src/tools/index.js | fa8033a1ebcece7e847ee7485a4f03cf9a1db3938d0a4650a42ff886b322d190 |
| backend/src/tools/exploration-state-factory.js | 23ad57ebedeec90ccee26bf9194f7513b3a5b3e592623fa596c5364625131642 |
| backend/src/modules/governance/runtime-tool-governance.js | 0bd37b78768c1f41d95352e2443ecf1ca9fb0324a59b72a2476235bee3718c1a |
| backend/src/modules/supervisor/ticket-agent-provider-routing.js | a8835614d386b37e86b162c3c1a7310fd427e88decdb34a2f01889a934822442 |

## 6. Git và giới hạn nghiệm thu

Đã xem `git_status` và `git_diff`; Git diff trả về bị truncate, các phần sửa đã đối chiếu bằng bounded source reads/anchors.
Worktree có 6 modified tracked files và 6 untracked source/test files, không staged/conflict. Báo cáo workflows giữ nội bộ và không add.
Chưa commit/push vì focused check FAILED và bản sửa sau FAIL chưa được kiểm chứng lại.
Không RUN production, không rollout, không thay approval identity/revision/hash hoặc immutable mutable manifest của ticket thật.

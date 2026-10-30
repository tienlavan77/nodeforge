<!--
Tài liệu bàn giao kỹ thuật chuyên biệt cho Phần B (Source Restructuring Phase) dành cho System Engineer (SE) sau khi Phần A đã được nghiệm thu hoàn tất.
Mục đích nghiệp vụ là tổ chức lại các mô-đun vận hành trong backend/src/ theo miền chức năng rõ ràng (agent, tools, supervisor) mà không làm suy giảm hành vi runtime, tính toàn vẹn bảo mật hay chất lượng truy xuất ngữ nghĩa (semantic retrieval).
Về mặt kỹ thuật, tài liệu tách Phần B thành 3 bước lớn (với Bước 3.3 chia làm 6 đợt cuốn chiếu độc lập), quy định rõ bảng kê phụ thuộc, kiểm chứng hồi quy hẹp sau từng cụm và các cổng nghiệm thu bắt buộc.
-->
# Bàn giao Phần B cho System Engineer (SE): Tái cấu trúc mã nguồn `backend/src/`

- **Người lập:** Architecture Manager (AM) | **Người thực thi:** System Engineer (SE)
- **Ngày ban hành:** 2026-10-29
- **Tài liệu gốc tham chiếu:** [se-repo-restructuring-handoff.md](se-repo-restructuring-handoff.md) (Mục 3 & Mục 4) và [se-repo-restructuring-progress.md](se-repo-restructuring-progress.md)
- **Trạng thái thực thi & nghiệm thu:** **ĐÃ HOÀN TẤT VÀ NGHIỆM THU TOÀN BỘ PHẦN B (`B.0`, `B.1`, `B.2`, `B.3.1`–`B.3.6` — Owner & AM ký nhận `PASS` ngày 2026-10-30)**. Xem báo cáo tổng kết tại [se-phase-b-final-report.md](se-phase-b-final-report.md).

---

## 0. Quy tắc bắt buộc trước và trong khi thực thi Phần B

1. **Bảo toàn thay đổi ngoài phạm vi & Snapshot trước mỗi đợt:**
   - Trước khi bắt đầu mỗi bước/cụm, ghi nhận danh sách file đang có thay đổi ngoài phạm vi trên working tree và đảm bảo có thể hoàn nguyên (rollback) riêng từng cụm mà không ghi đè các file ngoài phạm vi.
2. **Bảng kê phụ thuộc (Inventory Mapping) trước khi di chuyển:**
   - Không xem bất kỳ thay đổi runtime nào là "rủi ro = 0".
   - Trước mỗi cụm, lập bảng kê `source_path -> target_path` kèm `sha256`, đồng thời rà soát đầy đủ:
     - Import tĩnh (`import ... from`), dynamic `import()`, đường dẫn tính từ `import.meta.url` / `__dirname`.
     - String literal paths trong `backend/tests/**`, fixtures, eval corpus (`backend/tests/eval/**`) và policy/allowlist.
     - Exported symbols và các consumer gián tiếp bên ngoài cụm.
3. **Chạy Benchmark Semantic Retrieval trước và sau:**
   - Chạy `pnpm --dir backend eval:retrieval` (`node backend/tests/eval/run-retrieval-eval.mjs`) **trước khi bắt đầu Phần B** (làm baseline Phần B) và **sau mỗi bước (3.1, 3.2, 3.3)** trên cùng corpus, cấu hình và môi trường.
   - Lưu ý: Re-export mỏng chỉ giúp không gãy lệnh `import`, nhưng không chứng minh bộ máy tìm kiếm ngữ nghĩa truy xuất đúng file triển khai thực tế. Nếu file thực thi nằm trong ground truth của bộ eval được di chuyển hợp lệ, cập nhật minh bạch ánh xạ đường dẫn trong bộ eval và ghi rõ vào báo cáo (không sửa ground truth tùy tiện để làm đẹp chỉ số).
4. **Quy tắc comment và giới hạn dòng (`CLAUDE.md`):**
   - Chỉ thêm comment mục đích cho **file mới hoặc hàm/symbol mới**; không tự ý thêm/viết lại comment vào các file hiện hữu chỉ vì được di chuyển hoặc cập nhật đường dẫn import.
   - Mọi file tạo mới hoặc chỉnh sửa phải $\le 250$ `code_lines`.

---

## 1. Bước B.0 — Xử lý dứt điểm bài diagnostic `agent-discovery-baseline-comparison.test.js` (ĐÃ XÁC MINH & CHỐT CƠ CHẾ)

- **Hiện trạng đã xác minh:**
  1. Sau khi giữ `backend/src/tools/execution-file-access.js` và `backend/src/infrastructure/filesystem/coder-project-access.js` trong `environment.files`, cả hai cây đã khởi tạo thành công trong cùng môi trường (`environment_sha256: 20f1224fd3ceff8a6faed29e82ae7b44464d4ae5dc9534f6333b185649900f94`).
  2. Trên cây hiện tại (`current`), `system-engineer-sdk-tools.test.js` **PASS tuyệt đối (`exit_code: 0`, `failures: []`)**.
  3. Trên cây lịch sử (`baseline` tại commit `8d477bbca1901c30cd93872d5a65c2dc45f8f6cd`), khi chạy bộ assertion mới của `system-engineer-sdk-tools.test.js` trên working tree hiện tại, `baseline` trả `exit_code: 1` với 3 lỗi dự kiến do commit cũ chưa có các nâng cấp mới trên working tree (thiếu `move_file`/`lookup_schema` và thứ tự `delete_file` trong danh sách tool; log Anthropic cũ in 2 dòng cả `START` + completion thay vì chỉ 1 dòng completion).
  4. Do dòng 71 của `agent-discovery-baseline-comparison.test.js` đang ép `assert.deepEqual(current, previous)`, bài test bị fail nghịch lý khi `current` đã sửa xong (0 lỗi) còn `baseline` lịch sử vẫn mang lỗi cũ (3 lỗi).
- **Quyết định kỹ thuật của AM cho B.0:**
  - Cập nhật điều kiện nghiệm thu tại dòng 71 của `backend/tests/unit/agent-discovery-baseline-comparison.test.js` theo đúng nguyên tắc *No-New-Failure / Current-Pass*:
    - Kiểm tra `current.exit_code === 0` và `current.failures.length === 0` (hoặc mọi lỗi nếu có ở `current` phải là tập con đã có ở `previous.failures`, tức là không phát sinh bất kỳ lỗi hồi quy mới nào trên `current`).
    - Giữ nguyên kiểm tra `assert.equal(current.assertions_sha256, previous.assertions_sha256)` và đầy đủ log chẩn đoán JSON của cả 2 cây.
  - Chạy lại `node --test backend/tests/unit/agent-discovery-baseline-comparison.test.js` để lấy receipt `PASS` rồi chuyển ngay sang Bước B.1.

---

## 2. Bước B.1 — Hợp nhất `modules/agents/` vào `modules/agent/` & Đổi tên Adapter Registry

### B.1.1. Chuyển `agent-stream-bridge.js` sang `backend/src/modules/agent/agent-stream-bridge.js`
- Di chuyển `backend/src/modules/agents/agent-stream-bridge.js` $\rightarrow$ `backend/src/modules/agent/agent-stream-bridge.js`.
- Cập nhật import tại `backend/src/bootstrap/index.js:8` và mọi test/consumer liên quan.
- **Kiểm chứng bắt buộc:** Chạy `pnpm bootstrap:smoke` và kiểm tra khởi tạo bridge, chuyển tiếp sự kiện (event forwarding), hủy đăng ký listener (cleanup/unsubscribe) và hành vi che dấu thông tin nhạy cảm trên luồng lỗi (stderr redaction).

### B.1.2. Xác minh và dọn 3 module trong `backend/src/modules/agents/`
- Gồm 3 file:
  1. `backend/src/modules/agents/command-idempotency.js`
  2. `backend/src/modules/agents/concurrent-modification-detector.js`
  3. `backend/src/modules/agents/context-read-handler.js`
- **Yêu cầu:** Rà soát toàn bộ exported symbols, import tĩnh/động, CLI/runtime entrypoints và test consumers trên toàn repo. Chỉ xóa 3 file này và xóa thư mục rỗng `backend/src/modules/agents/` sau khi lập bảng chứng minh không còn bất kỳ consumer nào.

### B.1.3. Đổi tên `backend/src/modules/supervisor/agent-registry.js` $\rightarrow$ `supervisor-adapter-registry.js`
- Tránh trùng tên gây nhầm lẫn với `backend/src/modules/agent/agent-registry.js`.
- Cập nhật import tại `backend/src/modules/supervisor/production-runtime.js` và mọi tham chiếu tĩnh/động trong source/test.

### B.1.4. Bảo toàn neo cứng `backend/src/agents/agent-contract.js`
- **Giữ nguyên tuyệt đối** `backend/src/agents/agent-contract.js` tại vị trí cũ để không phá vỡ các neo kiểm định hệ thống và bộ đánh giá.

---

## 3. Bước B.2 — Tổ chức lại `backend/src/tools/` (49 files) theo 4 miền chức năng

Phân nhóm các file trong `backend/src/tools/` vào 4 thư mục con theo miền chức năng, giữ các file catalog/entry điều phối chung ở gốc `backend/src/tools/`:

1. **`backend/src/tools/discovery/` (Đọc, tìm kiếm, chỉ mục, trạng thái khám phá):**
   - `agent-file-index-view.js`, `claude-file-tools.js`, `exploration-state-factory.js`, `exploration-state.js`, `git-read-tools.js`, `lookup-schema-tool.js`, `project-ripgrep-runner.js`, `read-code.js`, `read-transcript-blocks.js`, `rg-files.js`, `rg-search.js`, `search-code.js`, `sed-lines.js`, `select-code-graph-candidates.js`.
2. **`backend/src/tools/roles/` (Công cụ và ràng buộc theo vai trò Owner / SL / Coder / Claude):**
   - `claude-forge-options.js`, `claude-sdk-forge-tools.js`, `owner-builtin-search-shell.js`, `owner-claude-mcp-tools.js`, `owner-conversation-tools.js`, `owner-delete-file.js`, `owner-engineer-tools.js`, `owner-role-tool-policy.js`, `owner-search-tree.js`, `sprint-leader-forge-tools.js`, `sprint-leader-web-search.js`.
3. **`backend/src/tools/reporting/` (Báo cáo, bằng chứng kiểm tra, review & kết quả công cụ):**
   - `agent-report-tool.js`, `completed-coder-report.js`, `node-report-evidence.js`, `query-review-tool.js`, `respond-to-review-tool.js`, `ticket-push-tool.js`, `ticket-report-commit.js`, `tool-log-event.js`, `tool-result-count.js`, `verification-command-evidence.js`.
4. **`backend/src/tools/governance/` (Quyền truy cập, kiểm tra quy ước, vòng đời, thực thi lệnh & xác minh):**
   - `agent-code-conventions.js`, `agent-command-tools.js`, `agent-file-mutation-tools.js`, `agent-lifecycle-tools.js`, `agent-verification-tools.js`, `execution-file-access.js`, `retrieval-governance.js`, `ticket-complexity.js`, `tool-authorization.js`.
5. **Giữ tại gốc `backend/src/tools/` (Entrypoint & Catalog cốt lõi):**
   - `index.js`, `engineering-tool-binding.js`, `engineering-tool-catalog.js`, `engineering-tool-implementations.js`, `engineering-tool-names.js`.
   - *(Lưu ý: Nếu một số file trong `backend/src/tools/` đang được khóa cứng đường dẫn trong các bài test bảo mật/baseline cố định mà việc di chuyển làm gãy đối chiếu lịch sử, SE được quyền giữ file thực thi hoặc đặt cầu nối minh bạch kèm báo cáo rõ trong inventory).*

---

## 4. Bước B.3 — Tổ chức lại `backend/src/modules/supervisor/` (255 files) theo 6 đợt cuốn chiếu độc lập

Thực hiện lần lượt từng đợt (chạy xong kiểm thử hẹp của đợt trước mới chuyển sang đợt sau):

1. **Đợt B.3.1 — `backend/src/modules/supervisor/browser/`:**
   - Di chuyển cụm 16 files `browser-*`. Chạy toàn bộ test unit/integration liên quan đến browser verification.
2. **Đợt B.3.2 — `backend/src/modules/supervisor/coder/`:**
   - Di chuyển cụm 14 files `coder-*` và `dependency-repair-*`. Chạy các bài test coder dispatch, autonomy và dependency repair.
3. **Đợt B.3.3 — `backend/src/modules/supervisor/blocker/`:**
   - Di chuyển cụm 72 files `blocker-*`. Chạy toàn bộ bài test blocker recovery, technical reconciliation và escalation.
4. **Đợt B.3.4 — `backend/src/modules/supervisor/review/`:**
   - Di chuyển cụm 52 files `review-*`, `reviewer-*`, `automatic-*`, `completed-review-*`, `committed-review-window.js`, `finding-review-source-resume.js`. Chạy toàn bộ bài test review gate và reviewer evidence.
5. **Đợt B.3.5 — `backend/src/modules/supervisor/ticket/`:**
   - Di chuyển cụm 71 files `ticket-*`. Chạy toàn bộ bài test ticket lifecycle, attempt release và verification environment.
6. **Đợt B.3.6 — Điều phối lõi tại `backend/src/modules/supervisor/` (ĐÃ CHỐT GIỮ CORE TẠI GỐC `supervisor/`):**
   - **Quyết định của AM (sau khi nghiệm thu B.3.1–B.3.5):** Chấp thuận giữ nguyên 39 file điều phối lõi, queues, workers, event/signal/status/result buses, namespace runner và task executors (`production-runtime.js`, `supervisor-manager.js`, `supervisor-loop.js`, `supervisor-runtime.js`, `supervisor-adapter-registry.js`, `durable-queue.js`, `sender-worker.js`, `collector-worker.js`, `verification-worker.js`, v.v.) ngay tại gốc `backend/src/modules/supervisor/` mà không tạo thêm thư mục con `runtime/`.
   - SE chỉ cần hoàn tất kiểm toán dependency/cycle cho nhóm core tại gốc, chạy kiểm chứng các bài test điều phối lõi theo nguyên tắc No-New-Failure Attribution, cập nhật câu trạng thái trong `STRUCTURE.md` và tổng hợp báo cáo nghiệm thu Phần B.
   - **Ghi chú attribution B.3.5 (`ticket-persistent-occupancy-recovery.test.js`):** AM đã chính thức nghiệm thu attribution cho 6 case occupancy (`PASS`) vì cả 2 cây dùng cùng `environment_sha256` (`3f8591ae...`), cùng `assertions_sha256` (`f6ee087b...`), cùng dừng tại dòng 60 (`assert.deepEqual(result.source_identities, EXPECTED_SOURCES)`), và delta của `production-runtime.js` (`f89f509e...` $\rightarrow$ `b126f142...`) chỉ là 5 dòng đổi đường dẫn import `./ticket/ticket-*` của B.3.5.

---

## 5. Cổng kiểm tra bắt buộc & Báo cáo nghiệm thu Phần B

Sau khi hoàn tất các bước và cập nhật `STRUCTURE.md` khớp với bố cục mới của `backend/src/`, SE chạy đầy đủ các cổng sau và ghi receipt vào `docs/se-repo-restructuring-progress.md`:

1. **Static & Convention Gates:**
   - Mọi file mới/sửa $\le 250$ `code_lines`.
   - `pnpm lint` (hoặc `pnpm --dir backend lint` + lint các file liên quan).
   - `pnpm typecheck` (hoặc `pnpm --dir backend typecheck`).
   - `pnpm validate:schemas`.
   - `pnpm bootstrap:smoke`.
2. **Unit, Integration & UI Build Gates:**
   - Toàn bộ các bài test backend bị ảnh hưởng theo từng cụm (`tools`, `agent`, `supervisor`, `governance`).
   - **Quy tắc đối chiếu lỗi tồn đọng trên working tree (No-New-Failure Attribution):** Do working tree hiện có các thay đổi runtime đồng thời ngoài phạm vi tái cấu trúc (chẳng hạn 27 assertion failure trên 17 file đã được chứng minh tồn tại y hệt trước B.2 tại `VERIFY-RUN-0cc73fee-6548-41cf-86e9-33a83901ad54` / `docs/se-phase-b2-test-attribution.md`), cổng kiểm thử theo cụm của B.2 và B.3 được công nhận đạt (`PASS` cho mục tiêu tái cấu trúc) khi:
     1. Mọi bài test không dính lỗi tồn đọng đều `PASS`.
     2. Mọi bài test báo fail đều được đối chiếu bằng snapshot đúng checksum ngay trước cụm di chuyển trên cùng môi trường (`compare-source-restructuring.mjs`), chứng minh **0 lỗi mới phát sinh** (cùng `exit_code`, cùng tập failure sau chuẩn hóa đường dẫn di chuyển, và giữ nguyên hash nội dung assertion).
     3. SE **không sửa runtime policy ngoài phạm vi** và **không sửa assertion trong các file test đang fail để ép xanh** trong lúc đang di chuyển cấu trúc thư mục B.2 / B.3.
   - 6 nhóm UI tests (`65 files`) và `pnpm --dir ui/nextjs build` (chạy lại ở cổng cuối sau khi hoàn tất B.3).
3. **Security & Semantic Retrieval Gates:**
   - `node --test backend/tests/unit/agent-discovery-baseline-comparison.test.js` (`PASS` theo nguyên tắc `current.exit_code === 0` và không phát sinh lỗi mới so với baseline).
   - `pnpm --dir backend eval:retrieval` sau mỗi bước (B.1, B.2, B.3) đối chiếu trực tiếp với **Baseline trước khi di chuyển source** đã thu thập tại receipt `VERIFY-RUN-ebdb80f6-2834-4614-861c-d7bba84d8192` (`Recall@4 = 0.2121`, `Precision@4 = 0.1364`, `Recall@8 = 0.3712`, `Precision@8 = 0.1023`, `hub_in_top2 = 0/11`, `11/11 cases completed`). Không yêu cầu viết thêm công thức `MRR`/`nDCG` ngoài các chỉ số chuẩn hiện có của `run-retrieval-eval.mjs`.

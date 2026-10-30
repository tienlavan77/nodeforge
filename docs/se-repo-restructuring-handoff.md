<!--
Tài liệu bàn giao kỹ thuật dành cho System Engineer (SE) để thực thi dọn dẹp tài liệu, chuẩn hóa kho mã nguồn và tái cấu trúc mô-đun vận hành NodeForge theo từng giai đoạn kiểm soát chặt chẽ.
Mục đích nghiệp vụ là làm sạch rác đã xác minh, chuẩn hóa tài liệu gốc và lịch sử, đồng thời tách bạch phần tái cấu trúc mã nguồn vận hành thành các cụm độc lập có đầy đủ bảng kê (inventory), kiểm chứng hồi quy và đánh giá chất lượng truy xuất ngữ nghĩa (semantic retrieval).
Về mặt kỹ thuật, bản cập nhật này tích hợp toàn bộ phản hồi từ docs/se-repo-restructuring-handoff-feedback.md: bảo toàn tuyệt đối backend/tool-lab-target.txt, phân biệt rõ trạng thái hiện hành trên workspace, bổ sung kiểm chứng O5 (pnpm/postinstall), quy định quy trình bảo toàn nội dung khi tách ARCHITECTURE.md và thiết lập đầy đủ các cổng kiểm tra bắt buộc.
-->
# Bàn giao cho System Engineer (SE): Tái cấu trúc và dọn dẹp Repo NodeForge (Bản cập nhật theo Feedback SE)

- **Người lập:** Architecture Manager (AM) | **Người thực thi:** System Engineer (SE)
- **Ngày cập nhật:** 2026-10-29 | **Tài liệu phản hồi tham chiếu:** `docs/se-repo-restructuring-handoff-feedback.md`
- **Phân định phạm vi & Trạng thái hiện tại:**
  - **Phần A (Hạng mục 1 & 2):** Thuộc phạm vi quản trị kho mã và chuẩn hóa tài liệu của sprint `SPRINT-NODEFORGE-99ba623d-r1-repository-governance` (O1–O5). **ĐÃ NGHIỆM THU PHẦN A** (đủ bằng chứng dọn rác, xóa `ui/src/`, `backend/src/domain/.gitkeep` và `docs/sprints/.gitkeep`, chuyển 15 file `.md` từ `backend/`, tách `ARCHITECTURE.md` thành 17 phần, gom 4 ảnh `.png` vào `docs/assets/`, archive `workflows/` và 112 tài liệu lịch sử trong `docs/archive/`, pass 8 file test backend (`VERIFY-RUN-515fee58-bcf8-4a0a-a425-4a7e87ef69df`), pass toàn bộ 65 file UI test theo 6 nhóm, pass lint và pass `pnpm --dir ui/nextjs build` (`VERIFY-RUN-b6ad6773-44bb-41eb-b7c9-3acfcb8ad319`)). Riêng bài diagnostic `agent-discovery-baseline-comparison.test.js` được AM đối chiếu: tại commit `8d477bbca1901c30cd93872d5a65c2dc45f8f6cd`, `rg-files.js` đã import `./execution-file-access.js` nhưng file này đang là untracked trong working tree nên khi mở rộng `ticketPaths` ra toàn bộ `backend/src`, `captureVerificationEnvironment` loại trừ các file untracked trong `backend/src` khiến archive baseline thiếu `execution-file-access.js`; trong khi bộ kiểm thử bảo mật trực tiếp `system-engineer-sdk-tools.test.js` trên cây hiện tại đã Pass (`exit_code: 0`). SE được phép khôi phục danh sách `ticketPaths` gốc trong `agent-discovery-baseline-comparison.test.js` (hoặc giữ untracked dependency trong environment) và chuyển sang thực thi **Phần B**.
  - **Phần B (Hạng mục 3 — Tài liệu chuyên biệt tại [`docs/se-phase-b-source-restructuring-handoff.md`](se-phase-b-source-restructuring-handoff.md)):** Là **phạm vi mở rộng (Source Restructuring Phase)** so với sprint cũ (vốn loại trừ di chuyển/đổi tên trong `backend/src/`). Phần B phải thực thi tách biệt sau khi khóa xong toàn bộ Phần A, có inventory, nhóm phụ thuộc, phương án hoàn nguyên (rollback) và bằng chứng nghiệm thu riêng.

---

## 0. Nguyên tắc bảo toàn Working Tree & Inventory trước khi thực thi

1. **Snapshot & Bảo toàn thay đổi ngoài phạm vi:**
   - Trước khi thao tác hàng loạt, ghi lại trạng thái `git status --porcelain`, `git diff` và danh sách hash SHA-256 của các file đang có thay đổi dở dang ngoài phạm vi (`coder-project-access`, `execution-file-access`, `review-verification-flow`, v.v.).
   - Lưu bằng chứng trước/sau từ trạng thái thật tại thời điểm bắt đầu (không dựng lại bằng chứng từ cây đã chỉnh sửa) và đảm bảo cơ chế rollback từng nhóm không ghi đè các file ngoài phạm vi.
2. **Bảng kê nguồn $\rightarrow$ đích (Inventory Mapping):**
   - Mọi thao tác di chuyển/tách file (cả tài liệu lẫn source) phải lập bảng kê `source_path -> target_path` kèm `sha256` trước khi sửa.
3. **Quy tắc comment đầu file (`CLAUDE.md`):**
   - Chỉ bắt buộc thêm comment mục đích cho **file mới hoặc hàm/symbol mới**; không tự ý thêm/viết lại comment vào các file hiện hữu chỉ vì được biên tập hoặc di chuyển.
   - Mọi file tạo mới hoặc biên tập lại phải đảm bảo $\le 250$ `code_lines`.

---

## 1. Phần A1 — Chốt rác cấp độ 1, Bảo toàn Marker & Chuẩn hóa `pnpm` (O1, O4, O5)

### 1.1. Phân loại trạng thái hiện tại trên Workspace & Hành động cần làm
1. **Các mục ĐÃ SỬA trong workspace — cần giữ và chạy kiểm chứng (`backend/tests/unit/repository-cleanup.test.js`):**
   - Đã xóa khỏi working tree các đường dẫn rác: `x`, `backend/x`, `title/` (`title/objective/acceptance_criteria`), `docs/giai-doan-3/code-cache-lint.log`.
   - Đã hợp nhất các bản trùng `conversation-content-analysis-architecture-plan.md` (`sha256: 19778e00...`) về một vị trí lưu trữ duy nhất tại `docs/archive/conversation-content-analysis-architecture-plan.md` (xóa bản ở `docs/` và `workflows/`).
   - Đã dọn 3 file legacy trong `ui/src/` (`agent-team-field.js`, `architecture-manager-selection.js`, `architecture-manager-selection.test.js`) và chuyển bài kiểm thử sang `ui/nextjs/tests/architecture-manager-selection.test.js`.
2. **Marker bắt buộc BẢO TOÀN TUYỆT ĐỐI (Không được xóa/di chuyển):**
   - `backend/tool-lab-target.txt` (`sha256: f62f677506d608e2adfcd8183c8881cde3ba04c979529722b37ba33ade5f5c84`): Đang được kiểm tra trực tiếp tại `backend/tests/unit/repository-cleanup.test.js` (AC-3, dòng 74–85) và được tham chiếu bởi `backend/src/modules/eval/eval-case-store.js` cùng `backend/src/tools/agent-report-tool.js`.
3. **Thư mục rỗng trong source (ĐÃ HOÀN TẤT):**
   - Đã xóa `backend/src/domain/.gitkeep` và thư mục rỗng `backend/src/domain/` (được kiểm chứng tại `backend/tests/unit/repository-cleanup.test.js` và `backend/tests/unit/system-engineer-restructuring-access.test.js`).
4. **Chuẩn hóa `pnpm` và script `postinstall` (O5 — ĐÃ HOÀN TẤT):**
   - `backend/scripts/repair-npm-bin-links.mjs` đã được cập nhật dùng `resolve(dirname(fileURLToPath(import.meta.url)), "../..")` để tính đúng gốc repo và có bài kiểm thử tự động `backend/tests/unit/repair-npm-bin-links.test.js`.

---

## 2. Phần A2 — Chuẩn hóa `docs/`, `workflows/`, `STRUCTURE.md` và `ARCHITECTURE.md` (O2, O3)

### 2.1. Gom 15 file `.md` thiết kế nằm lẫn trong `backend/` về `docs/architecture/` (ĐÃ HOÀN TẤT)
- Đã lập inventory kèm SHA-256 (`backend/tests/fixtures/repository-document-inventory.json`) và kiểm chứng bảo toàn byte tại `backend/tests/unit/repository-document-preservation.test.js` cho toàn bộ 15 file chuyển về `docs/architecture/`:
  - **Từ `backend/` (9 files):** `automatic-blocker-recovery.md`, `blocker-recovery.md`, `blocker-technical-reconciliation.md`, `error-routing-recovery.md`, `implementation-autonomy.md`, `multi-project-agent-attribution.md`, `multi-project-lifecycle.md`, `reviewer-coder-collaboration.md`, `reviewer-evidence.md`.
  - **Từ `backend/src/` (6 files):** `application/owner-execution-checkpoint.md`, `modules/governance/architecture-clarifications.md`, `modules/governance/plan-decision-requests.md`, `modules/supervisor/browser-verification.md`, `modules/supervisor/review-records.md`, `modules/supervisor/ticket-attempt-release.md`.

### 2.2. Quy hoạch `docs/` và `workflows/` (ĐÃ HOÀN TẤT & NGHIỆM THU)
1. **Quy hoạch `docs/`:**
   - `docs/architecture/`: Đã chứa 15 file thiết kế gốc chuyển từ `backend/` (cùng file tách riêng `ordinary-verification-write-sandbox.md` có kiểm chứng lineage tại `repository-lifecycle-lineage.test.js`) và 17 phần tách ra từ `ARCHITECTURE.md` (`reference-01.md` $\rightarrow$ `reference-17.md`).
   - `docs/assets/` (**ĐÃ HOÀN TẤT**): Cả 4 file ảnh (`bo-nen-chu.png`, `prompt-satus-bar.png`, `so-do-a.png`, `so-do-b.png`) đã chuyển nguyên byte về `docs/assets/`, cập nhật đường dẫn và kiểm chứng tại `backend/tests/fixtures/repository-assets-inventory.json`.
   - `docs/archive/` (**ĐÃ HOÀN TẤT**): Đã đưa 112 tài liệu lịch sử từ 6 nhóm (`sprints/`, `giai-doan-2/`, `giai-doan-3/`, `markdowns/`, `prompt/`, `reports/`) vào `docs/archive/`, tách 23 tài liệu quá kích thước thành 88 phần có thể tái dựng đầy đủ hash gốc (`repository-historical-docs-inventory.json`), và xóa sạch `docs/sprints/.gitkeep` (hash trước xóa `01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b`) để không còn thư mục `docs/sprints/` rỗng.
   - `docs/README.md`: Đã cập nhật chỉ mục tài liệu, ảnh và bộ sưu tập lịch sử, đồng bộ trạng thái nghiệm thu Phần A.
2. **Quy hoạch `workflows/` (ĐÃ HOÀN TẤT):**
   - Đã giữ nguyên tuyệt đối `workflows/agents/**`, `workflows/README.md` và `workflows/architecture-plan-json-first-guide.md`.
   - Đã chuyển các file lịch sử ở `workflows/` vào `workflows/archive/plans/`, `workflows/archive/reports/`, `workflows/archive/discussions/` kèm kiểm chứng SHA-256 tại `backend/tests/fixtures/repository-workflow-inventory.json` và `repository-workflow-archive-inventory.json`.

### 2.3. Cập nhật `STRUCTURE.md` và tách `ARCHITECTURE.md` có kiểm chứng bảo toàn nội dung (ĐÃ HOÀN TẤT)
- **`STRUCTURE.md`:** Cập nhật khớp cấu trúc thực tế của repo, $\le 250$ `code_lines`.
- **`ARCHITECTURE.md` (hiện 3098 dòng / 2344 `code_lines`):**
  1. Lưu SHA-256 bản gốc, lập danh sách thứ tự từng mục (section inventory) và bảng ánh xạ từng phần sang các file đích trong `docs/architecture/*.md`.
  2. Đảm bảo nội dung tách ra có thể đối chiếu khôi phục đầy đủ theo đúng thứ tự gốc, không rơi rụng thông tin kỹ thuật.
  3. Cập nhật mọi liên kết tương đối, tham chiếu ảnh và consumer đọc file thật.
  4. Giữ `ARCHITECTURE.md` ở gốc repo làm bản tổng quan và chỉ mục kiến trúc ($\le 250$ `code_lines`), đồng thời mọi file đích trong `docs/architecture/` đều $\le 250$ `code_lines`.

---

## 3. Phần B — Tái cấu trúc `backend/src/` (Phạm vi mở rộng — Thực thi theo cụm độc lập)

> **Quy tắc chung cho Phần B:** Không xem bất kỳ thay đổi runtime nào là "rủi ro = 0". Trước mỗi bước phải lập inventory gồm: import tĩnh, `import()` động, đường dẫn tính từ `import.meta.url`/`__dirname`, string literal paths trong test/eval/fixtures, và exported symbols. Thực hiện cuốn chiếu từng nhóm và đảm bảo có thể hoàn nguyên độc lập từng nhóm.

### Bước 3.1 — Hợp nhất `modules/agents/` vào `modules/agent/` & Đổi tên Adapter Registry
1. **Chuyển `agent-stream-bridge.js` sang `backend/src/modules/agent/agent-stream-bridge.js`:**
   - Cập nhật import tại `backend/src/bootstrap/index.js:8`.
   - **Kiểm chứng bắt buộc:** Kiểm tra đường nạp bootstrap (`pnpm bootstrap:smoke`), khởi tạo bridge, chuyển tiếp sự kiện (event forwarding), hủy đăng ký listener (cleanup/unsubscribe) và hành vi che dấu thông tin nhạy cảm trên luồng lỗi (stderr redaction).
2. **Xác minh trước khi xóa 3 module trong `backend/src/modules/agents/` (`command-idempotency.js`, `concurrent-modification-detector.js`, `context-read-handler.js`):**
   - Không chỉ tìm theo tên file: phải rà soát toàn bộ exported symbols, import gián tiếp, dynamic loading, CLI/runtime entrypoints và test consumers. Chỉ xóa file và xóa thư mục `backend/src/modules/agents/` sau khi có bằng chứng xác nhận không còn consumer nào.
3. **Đổi tên `backend/src/modules/supervisor/agent-registry.js` $\rightarrow$ `supervisor-adapter-registry.js`:**
   - Cập nhật import tại `backend/src/modules/supervisor/production-runtime.js` và kiểm tra mọi tham chiếu tĩnh/động trước khi đổi tên.
4. **Giữ nguyên `backend/src/agents/agent-contract.js`:** Không di chuyển để bảo toàn các neo cứng trong hệ thống và tập đánh giá.

### Bước 3.2 — Tổ chức lại `backend/src/tools/` (49 files)
- Phân nhóm các module vào 4 thư mục con theo miền: `tools/discovery/`, `tools/roles/`, `tools/reporting/`, `tools/governance/`, giữ các catalog/entry chính tại `backend/src/tools/`.
- **Quản trị phụ thuộc & Retrieval:**
  - Lập inventory đầy đủ các consumer trong `backend/src/**` và ~95 file test trong `backend/tests/**`.
  - Lưu ý: Re-export mỏng chỉ giúp không gãy lệnh `import`, nhưng **không chứng minh** bộ máy tìm kiếm ngữ nghĩa (semantic retrieval) truy xuất đúng file triển khai thực tế. Vì vậy, phải chạy đánh giá retrieval (`pnpm --dir backend eval:retrieval`) và cập nhật minh bạch ánh xạ đường dẫn trong bộ eval nếu di chuyển file thực thi được neo trong ground truth (không sửa ground truth tùy tiện để làm đẹp chỉ số).

### Bước 3.3 — Tổ chức lại 255 files trong `backend/src/modules/supervisor/` theo 6 cụm độc lập
- Chia thành 6 đợt cuốn chiếu độc lập theo thứ tự:
  1. `supervisor/browser/` (16 files `browser-*`)
  2. `supervisor/coder/` (14 files `coder-*` và `dependency-repair-*`)
  3. `supervisor/blocker/` (72 files `blocker-*`)
  4. `supervisor/review/` (52 files `review-*`, `reviewer-*`, `automatic-*`, `completed-review-*`, `committed-review-window.js`, `finding-review-source-resume.js`)
  5. `supervisor/ticket/` (71 files `ticket-*`)
  6. `supervisor/runtime/` (hoặc giữ ở gốc `supervisor/` cho các file điều phối lõi).
- Kết thúc mỗi cụm phải chạy bộ test hẹp của cụm đó và kiểm tra không làm lệch các thay đổi ngoài phạm vi trước khi sang cụm tiếp theo.

---

## 4. Cổng kiểm tra bắt buộc & Tiêu chí nghiệm thu (Verification & Evidence Gates)

Với mỗi đợt thực thi, SE phải lưu lại **bản ghi bằng chứng** gồm: `git rev-parse HEAD`, môi trường (`node -v`, `pnpm -v`), câu lệnh thực thi, mã thoát (exit code), tóm tắt kết quả và đường dẫn log output. Khi có test lỗi, phải đối chiếu với baseline trên cùng môi trường và assertion (không tự kết luận là "lỗi cũ" nếu chưa có bằng chứng baseline).

1. **Cổng kiểm tra tĩnh & Quy ước (Static & Convention Gates):**
   - Kiểm tra mọi file mới/chỉnh sửa $\le 250$ `code_lines`.
   - Root Lint: `pnpm lint` (hoặc `pnpm --dir backend lint`).
   - Typecheck: `pnpm typecheck` (hoặc `pnpm --dir backend typecheck`).
   - Schema Validation: `pnpm validate:schemas`.
   - Bootstrap Smoke: `pnpm bootstrap:smoke`.
2. **Cổng kiểm tra Unit, Integration & UI Build:**
   - Backend Tests: `pnpm --dir backend test` (và chạy kiểm tra hẹp theo từng nhóm khi di chuyển từng cụm, ví dụ `node --test backend/tests/unit/repository-cleanup.test.js`).
   - UI Tests (chạy qua Node test runner vì `ui/nextjs/package.json` chỉ có script `dev`/`build`/`start`):
     `node --test ui/nextjs/tests/*.test.js` (hoặc chạy tổng thể qua root `pnpm test`).
   - Next.js Production Build: `pnpm --dir ui/nextjs build`.
3. **Cổng kiểm tra Security Baseline Attribution & Semantic Retrieval Quality:**
   - **Security Baseline Attribution:** `node --test backend/tests/unit/agent-discovery-baseline-comparison.test.js` (xác nhận không làm hỏng quy kết hồi quy bảo mật giữa nguồn hiện tại và baseline cố định).
   - **Semantic Retrieval Benchmark:** Chạy `pnpm --dir backend eval:retrieval` (`node backend/tests/eval/run-retrieval-eval.mjs`) **trước và sau** mỗi đợt di chuyển source trên cùng corpus, cấu hình và môi trường; lưu bảng so sánh các chỉ số (`Recall`, `MRR`, `nDCG`, pass rate) để chứng minh không suy giảm chất lượng truy xuất.

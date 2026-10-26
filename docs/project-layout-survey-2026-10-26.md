<!-- Survey of the current repository layout for the owner's project reorganization decision: documents drifted STRUCTURE.md vs real backend/ui layout, oversized ARCHITECTURE.md, flat workflows/ artifact pile, duplicated and empty junk files, dirty working tree, plus a risk table and owner open questions. Evidence-only, not an approved plan. -->
# Khảo sát: hiện trạng tổ chức repo NodeForge (2026-10-26)

- **Người lập:** Architecture Manager (AM).
- **Loại tài liệu:** Kết quả khảo sát phục vụ owner quyết định "sắp xếp lại project".
- **Trạng thái:** Chưa phải plan được duyệt; chưa có quyền RUN/dispatch. Muốn biến thành plan: `/plan docs/project-layout-survey-2026-10-26.md`.

## 1. Mục tiêu khảo sát

- **Vấn đề:** Repo phình theo tích lũy lịch sử (plans, reports, summaries, audits nhiều đời), tài liệu mô tả cấu trúc lệch so với code thực tế, có file rác/duplicate, working tree dirty kéo dài.
- **Kết quả mong đợi:** Owner nhìn ra đâu là rác có thể dọn ngay, đâu là thay đổi cấu trúc cần plan riêng, đâu là rủi ro phải giữ.
- **Giá trị:** Giảm nhiễu cho semantic retrieval (mục tiêu được nêu trong `CLAUDE.md`), giảm chi tiết "find the right file".

## 2. Phạm vi khảo sát

In scope: cấu trúc thư mục cấp repo, tài liệu kiến trúc/cấu trúc, vị trí artifact workflow, file nghi rác, trạng thái Git.
Out of scope: chất lượng code từng module, refactor implementation, đổi public contract/schema.

## 3. Facts có evidence

### 3.1 Cấu trúc khai báo lệch với cấu trúc thật

| Khai báo trong `STRUCTURE.md` | Thực tế | Evidence |
| --- | --- | --- |
| `src/`, `tests/`, `config/`, `scripts/` ở gốc | Code nằm trong `backend/src/`, `backend/tests/`, `backend/scripts/` | `STRUCTURE.md` (sha256 `65949123…`); `search_tree backend/src` trả 152 entries |
| `src/domain/` chứa "Project, task, session, rule and workflow policies" | `backend/src/domain` là **rỗng** (0 entries) | `search_tree backend/src/domain` |
| `src/modules/` gồm 11 module cố định | Thực tế có 16 module: thêm `agent`, `agents`, `eval`, `governance`, `protocol`, `supervisor`; không có `agents/context` như mô tả một số chỗ | `search_tree backend/src/modules` |
| `workflows/` = "Committed workflow state-machine definitions" | `workflows/` đang là workspace tài liệu của AM (`plan-*`, `report-*`, `summary-*`, `audit-*`, `discussion-*`) | `workflows/README.md` (sha256 `ab533094…`), `search_tree workflows` ≥81 file |
| Runtime `.forge/` được ignore | Có `.nodeforge/test-tmp/**` xuất hiện trong `list_files` (danh sách loại trừ file ignored) nhưng không xuất hiện untracked trong `git status` | `list_files`, `git_status` — **cần verify `.gitignore`** |

Kết luận có căn cứ: `STRUCTURE.md` là tài liệu cũ, mô tả bố cục đã bị thay bởi layout `backend/` + `ui/`. Nó là nguồn sai lệch lớn nhất cho discovery.

### 3.2 ARCHITECTURE.md vượt giới hạn kích thước của repo rule

- `ARCHITECTURE.md`: **3098 total lines / 2344 code lines** (sha256 `21b0dd4f…`).
- `CLAUDE.md` quy định mọi file ≤ 250 `code_lines`.
- File còn là "tổng hợp cuộc trao đổi" nhiều đời (V1.3), không phải tài liệu tra cứu theo chủ đề.

### 3.3 Artifact workflow dồn đống phẳng trong `workflows/`

- ≥81 file một cấp, trộn nhiều loại: `plan-*` (~40), `report-*` (~35), `discussion-*`, `summary-*`, `audit-*`, `thong-tin-agent.md`, `SUMMARY-9e328f41-….md` (tên theo UUID — đúng loại ID mà `README.md` nói "no generated SUMMARY ID is needed").
- `workflows/README.md` tự mô tả mình là "Architecture Manager workspace", tức semantics đã đổi so với `STRUCTURE.md`.
- `workflows/PLAN-PROJECT-NODEFORGE-bd95299a-…/ke-hoach-r1.md` đang bị xóa trong Git: artifact sinh theo project/UUID đã từng được commit vào `workflows/`.

### 3.4 Trùng lặp và file rác

| Path | Vấn đề | Evidence |
| --- | --- | --- |
| `docs/conversation-content-analysis-architecture-plan.md` vs `workflows/conversation-content-analysis-architecture-plan.md` | **Giống hệt nhau từng byte** (cùng sha256 `19778e0000…`, 14652 bytes) | Hai lần `read_file` |
| `x` (gốc) | File rỗng 0 bytes | sha256 `e3b0c442…` (empty), size 0 |
| `backend/x` | File rỗng 0 bytes | sha256 `e3b0c442…`, size 0 |
| `backend/tool-lab-target.txt` | 76 bytes, tên dạng target thử nghiệm tool | sha256 `f62f6775…` |
| `title/objective/acceptance_criteria` | Cây thư mục lệch lạc ở gốc repo, như hậu quả của một lệnh tạo file sai đường dẫn | `search_tree title` |
| `docs/giai-doan-3/code-cache-lint.log` | File log nằm trong `docs/` | `search_tree docs/giai-doan-3` |

### 3.5 Tài liệu nằm sai chỗ

- 10 file `.md` ở ngay `backend/`: `blocker-recovery.md`, `automatic-blocker-recovery.md`, `blocker-technical-reconciliation.md`, `error-routing-recovery.md`, `implementation-autonomy.md`, `multi-project-agent-attribution.md`, `multi-project-lifecycle.md`, `reviewer-coder-collaboration.md`, `reviewer-evidence.md` — tài liệu thiết kế trong root của package code.
- `backend/src/application/owner-execution-checkpoint.md` — doc nằm giữa source.
- `docs/` là catch-all không có index: `giai-doan-2`, `giai-doan-3` (37 file), `markdowns` (23 file), `reports`, `sprints`, `prompt`; trộn `.png` (`bo-nen-chu.png`, `prompt-satus-bar.png` — typo "satus") với plan kiến trúc và tài liệu đã lỗi thời (`docs/markdowns/FORGE_WORKFLOW_AND_SCHEMAS_v1.md` vs `FORGE_WORKFLOW_v2.md` vs `SCHEMA_STRUCTURE.md`).

### 3.6 UI hai đời song song

- `ui/src` chỉ còn **3 file**: `agent-team-field.js`, `architecture-manager-selection.js`, `architecture-manager-selection.test.js`.
- UI thật là `ui/nextjs` (`app/`, `components/`, `lib/`, `tests/`, Next.js + Tailwind).
- `README.md`: "`pnpm dev` runs Control API, Watcher/Code Index and the Next.js UI. The legacy Vite app remains available separately with `pnpm dev:web` until the Next.js replacement is approved." → tồn tại có chủ đích, chờ quyết định approve, **không phải rác**.
- Chi tiết đáng chú ý: test JSX nằm cạnh source trong `ui/src`, còn test UI thật nằm ở `ui/nextjs/tests`.

### 3.7 Working tree dirty kéo dài

`git_status`: **81 changed files** (15 staged, 41 unstaged, 28 untracked, 0 conflicted).
- Có cặp **`D` staged + `??` untracked trùng path**: `backend/src/application/conversation-plan-approval-service.js`, `conversation-planning-service.js`, `backend/src/modules/governance/architecture-plan-json.js`, `conversation-plan-source.js`, `conversation-plan-trigger.js`, `backend/src/shared/rfc7396-merge-patch.js`, và các test tương ứng (`architecture-plan-json-contract.test.js`, `conversation-plan-*.test.js`). Dấu hiệu một đợt đổi chỗ/đổi cơ chế đang dở.
- Untracked mới trong `workflows/`: `plan-gate-architecture-json-first.md`, `plan-gate-architecture-json-first-revision.md` — cùng một chủ đề ở hai revision, nằm ngoài plan contract.

### 3.8 Đặt tên trùng nghĩa trong backend

- `backend/src/agents/agent-contract.js` vs `backend/src/modules/agent/` vs `backend/src/modules/agents/` (hai module số ít/số nhiều cùng tồn tại).
- `backend/src/tools/` có 49 file phẳng, trộn theo owner/role: `owner-*`, `agent-*`, `engineering-tool-*`, `claude-*`, `sprint-leader-*`, `rg-*`/`search-code`/`read-code` — nhiều khả năng là nơi phình tiếp theo.

## 4. Phân loại đề xuất cho owner

### Nhóm A — dọn không cần discussion (rủi ro thấp, đã có evidence)
1. Xóa `x`, `backend/x` (0 bytes).
2. Xóa hoặc chuyển `backend/tool-lab-target.txt` nếu không còn là target của script test nào (cần grep trước — chưa kiểm chứng).
3. Xóa `title/objective/acceptance_criteria` (cấu trúc sai layout).
4. Bỏ một trong hai bản `conversation-content-analysis-architecture-plan.md` trùng sha256; giữ bản đúng theo workflow hiện hành (`README.md` chỉ đường dẫn `.md` làm nguồn `/plan`).
5. Đưa `docs/giai-doan-3/code-cache-lint.log` ra khỏi `docs/`.

### Nhóm B — sửa tài liệu mô tả (rủi ro trung bình, ảnh hưởng discovery)
6. Viết lại `STRUCTURE.md` theo layout thật (`backend/`, `ui/`, `schemas/`, `workflows/agents/`), hoặc đánh dấu rõ "lịch sử" và trỏ tới tài liệu hiện hành.
7. Tách `ARCHITECTURE.md` thành các tài liệu theo chủ đề trong `docs/` để tuân thủ trần 250 code lines.
8. Chốt semantics của `workflows/`: hoặc "định nghĩa state machine" (theo `STRUCTURE.md`), hoặc "workspace tài liệu AM" (theo `workflows/README.md`). Hai tài liệu đang mâu thuẫn.

### Nhóm C — cần quyết định cấu trúc (vượt thẩm quyền AM, phải owner duyệt)
9. Tổ chức lại `workflows/` theo nhóm vòng đời, ví dụ `workflows/agents/` (rulebook) | `workflows/plans/` | `workflows/reports/` | `workflows/archive/`; cấm artifact theo UUID/project-ID được commit.
10. Gom tài liệu design khỏi `backend/` và `backend/src/**` về `docs/`.
11. Dọn `docs/`: index, tách `docs/assets/` cho ảnh, tách `docs/legacy/` cho tài liệu đã supersede.
12. Phê quyết định Next.js thay Vite để cho phép xóa `ui/src`.
13. Gom module `agent` vs `agents`, cân nhắc chia `backend/src/tools/` theo nhóm.

## 5. Assumptions (chưa phải fact)

- `title/` là sản phẩm của một lệnh tạo file sai đường dẫn, không phải tính năng. Chưa có evidence tuyệt đối.
- `backend/tool-lab-target.txt` là target thử nghiệm. Chưa grep để xác nhận.
- Các bản `docs/markdowns/FORGE_*` cũ đã supersede — chưa đối chiếu nội dung từng file.

## 6. Risks

| Rủi ro | Mức | Cách xử lý |
| --- | --- | --- |
| Đổi đường dẫn `workflows/*` làm hỏng reference cứng trong code/test | Blocker | Trước khi đổi, grep toàn repo; hiện mới chỉ thấy reference `workflows/plan.md` trong **test fixture UI** (`ui/nextjs/tests/conversation-markdown-*.test.js`), chưa khảo sát backend |
| Xóa `docs/` hoặc `workflows/` file đang là **nguồn `/plan`** đã ghi checksum | Major | `README.md`: sửa source sau khi tạo plan bắt buộc tạo draft mới; xóa file đang được tham chiếu sẽ phá provenance |
| Dọn khi working tree 81 file dirty | Major | Commit/reconcile đợt đang dở trước; nếu không sẽ lẫn "dọn dẹp" với "chưa xong" |
| `ARCHITECTURE.md` có thể được runtime đọc/đối chiếu | Major | Chưa kiểm chứng; phải grep trước khi tách file |
| Xóa `ui/src` khi chưa approve Next.js | Major | Thuộc Nhóm C, owner quyết |

## 7. Open questions cho owner

1. Ưu tiên: dọn rác ít rủi ro ngay, hay tái cấu trúc `workflows/` + `docs/` (lợi ích retrieval lớn hơn nhưng đụng reference)?
2. `workflows/` nên mang semantics gì chính thức?
3. `ARCHITECTURE.md` có phải artifact mà Node/schema đối chiếu không, hay thuần tài liệu?
4. Cho phép xóa tài liệu `docs/legacy` (`giai-doan-2`, `giai-doan-3`, `markdowns`) hay phải archive giữ lịch sử?
5. Next.js đã được approve thay Vite chưa?
6. Working tree dirty hiện tại là công việc đang chạy (phải để yên) hay đã xong (cần commit)?

## 8. Ghi chú phương pháp

Toàn bộ số liệu trên lấy từ: `search_tree` (`.`, `backend/src`, `ui/src`, `ui/nextjs`, `workflows`, `docs`, `docs/markdowns`, `docs/giai-doan-3`, `title`, `backend/src/modules`, `workflows/agents`, `backend/src/domain`), `read_file` (`STRUCTURE.md`, `ARCHITECTURE.md`, `README.md`, `workflows/README.md`, `package.json`, `backend/package.json`, `vocabulary/rename-suggestions.md`, hai bản `conversation-content-analysis-architecture-plan.md`, `x`, `backend/x`, `backend/tool-lab-target.txt`), `list_files`, `search_text`, `git_status`. Chưa khảo sát: nội dung backend reference tới `workflows/`/`docs/`, `.gitignore`, chi tiết `schemas/`, `Skills/`.

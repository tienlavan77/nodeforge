# Báo cáo: Triển khai giai đoạn 3 — Remediation quyền truy cập Coder/Reviewer

Ngày: 2026-10-22. Trạng thái repository: branch `ui-chat`, base commit HEAD `4ad1035` ("Update project changes"). Toàn bộ thay đổi đang ở working tree, **chưa commit/push** (chờ owner yêu cầu).
Kế hoạch được thực thi: `workflows/plan-coder-reviewer-file-access-policy-remediation.md` (outcomes R1–R6).
Môi trường kiểm chứng: Node **v18.19.1** (`/usr/bin/node`), sandbox Bash, `TMPDIR=/home/data/sites/nodeforge/.nodeforge/test-tmp`.

## 1. Kết luận ngắn

- **R1 (boundary chống race): ĐẠT** ở mức đơn vị tích hợp (coordinated race test trên thư mục thật, syscall-level symlink swap). Đây là PASS của deny controls + object binding — **không** đồng nghĩa chứng nhận rollout provider end-to-end (Deny ≠ PASS).
- **R2 (cache/index/chịu authority hiện hành): ĐẠT** một phần theo phạm vi đã chốt của kế hoạch (read/write ở boundary thật với warm cache/index/graph); semantics thu hồi đầy đủ vẫn chờ §3.1.
- **R3: KHÔNG MỞ.** `run_check` vẫn `TOOL_LOCKED` với v2 grant; `REVIEW_CHECK_ISOLATION_UNSUPPORTED` vẫn còn hiệu lực. Không có bằng chứng isolation subprocess → route tiếp tục chặn.
- **R4: MỘT PHẦN.** Composition/recovery phía đọc tái kiểm chứng (runtime governance tests pass). Phân loại governance cho route ghi docs vẫn thuộc quyền owner → không tự chốt.
- **R5: NOT RUN / NOT CERTIFIED.** Yêu cầu Node `>=22.5.0`; sandbox chỉ có v18.19.1 (đã tìm nvm/volta/fnm — không có). Integration re-run và matrix provider×mode **chưa chạy**, ghi rõ NOT CERTIFIED, không suy từ shared definitions.
- **R6: BLOCKED.** Cần hai quyết định authority §3.1 (chưa được tự chốt theo guardrail) và R1–R5 đạt; smoke v2 end-to-end **NOT RUN**.

## 2. Bằng chứng đã kiểm chứng (VERIFIED)

### 2.1. Bộ test race mới (R1/R2)

`backend/tests/unit/execution-file-access-race.test.js` — 2/2 PASS:

```
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null TMPDIR=.../backend/.nodeforge/test-tmp \
OPENSSL_CONF=/dev/null node --test tests/unit/execution-file-access-race.test.js
# pass 2 / fail 0
```

R1 — coordinated check-to-use race, trên project root thật (`mkdtemp`), hoán vị file↔symlink được phối hợp qua hook bọc FileService **sau** `bindEngineeringTools.assertPath` preflight, **trước** open thật:

| Kịch bản | Kết quả |
|---|---|
| Allow control: đọc thường `backend/caller.js` (read_file/read_lines) | PASS (nội dung đúng) |
| Leaf swap → symlink ra `outside/external.js` trước `readForIndex` | Chặn: `FILE_ACCESS_UNSAFE_PATH` ("Linked paths…") |
| Leaf swap → symlink vào `.env` trước read_lines | Chặn: `FILE_ACCESS_UNSAFE_PATH` |
| Ancestor dir swap (`backend/sub` → symlink outside) | Chặn: `FILE_ACCESS_UNSAFE_PATH` |
| write_diff: sau khi before_checksum đã verify, target swap → symlink `AGENTS.md` | Chặn; `AGENTS.md` bytes không đổi |
| edit_diff, target swap → symlink outside | Chặn; `outside/external.js` bytes không đổi |
| Create under authorized prefix, swap target missing → symlink outside | Chặn; allow control create thường PASS |
| `codeCache.refreshChanged` trên file đã swap thành symlink `.env` | Trả `"invalidated"`; `search_text` không lộ `SECRET_TOKEN/TOP_SECRET_ENV` |
| Over-grant (`.env`, `AGENTS.md`, `workflows/plan.md` nằm trong grant) | Deny thắng: `read_file(".env")` → `FILE_ROLE_FORBIDDEN` (role preflight đi trước grant); write `AGENTS.md`/`workflows/plan.md` → `PATH_FORBIDDEN` |

R2 — warm cache/index/graph dưới authority thu hẹp và thu hồi, ở boundary thật (không mock callback giả):

| Kiểm tra | Kết quả |
|---|---|
| Warm cache `ui/panel.js` dưới broad grant, rồi narrow grant `["backend"]` | read_file → `PATH_FORBIDDEN`; read_code → `READ_PATH_FORBIDDEN`; Claude Read → `TOOL_RESOURCE_FORBIDDEN` — cache hit ấm **không** được phục vụ vượt grant hiện hành |
| Graph edges trên cache hit `backend/caller.js` | Cắt cạnh tới `ui/panel.js`: `imports == [{backend/caller.js}]`, `imported_by/calls == []` |
| `search_code` projection graph | Match và edge tới ui bị loại; JSON không chứa `panel.js|UI_ONLY` |
| `select_code_graph_candidates` ticket-cached + live selector | Chỉ còn `backend/caller.js`; `stale_paths` bị lọc |
| Claude Glob/Grep warm cache | Không lộ `ui/panel.js` |
| Thu hồi (`authorizeCurrent` → false) | Cả 5 tool reject `FILE_ACCESS_POLICY_INVALID` ngay lập tức |

### 2.2. Suite chính sách và liên quan (đã chạy lại, PASS)

| Lệnh (`node --test`) | Kết quả |
|---|---|
| `tests/unit/execution-file-access-policy.test.js` | 11/11 PASS — gồm test `run_check` → `TOOL_LOCKED` (R3 giữ khóa) và test denial graph/metadata không lộ path bị từ chối |
| Batch: file-service, execution-file-access-policy/discovery/race, reviewer-snapshot-discovery, verification-environment-boundary, coder-path-permissions, coder-reviewer-capabilities, engineering-tool-binding, agent-lifecycle-tools-v2 | 68/69 — 1 FAIL tồn tại sẵn (xem §3) |
| Batch tools: read-code, rg-files, rg-search, sed-lines, select-code-graph-candidates, search-code, claude-file-tools, code-cache-service, code-cache-write-invalidation, runtime-tool-governance | 74/74 PASS |
| Batch supervisor: review-worker, reviewer-forge-tools, reviewer-committed-source, nodeforge-task-sdk-events, engineering-tool-catalog, governance-dependency-graph | 34/35 — 1 FAIL tồn tại sẵn (xem §3) |
| ESLint (--rulesdir eslint-rules, --max-warnings=0) trên toàn bộ source/test đã sửa trong scope | Exit 0, không warning |

### 2.3. Cơ chế nền đã chốt (tóm tắt implementation)

- `backend/src/infrastructure/filesystem/safe-object-open.js` (mới, 84 dòng): open lá với `O_NOFOLLOW` (read-only cho đọc; `O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW` cho ghi); `projectIndexPath` lstat-walk ancestors; `bindObject` đối chiếu `(dev, ino)` của handle đã mở với `statSync` canonical mới → ancestor swap giữa walk và open cũng bị bắt; non-regular leaf từ chối; mọi vi phạm → `FILE_ACCESS_UNSAFE_PATH` (fail-closed, không echo nội dung).
- `file-service.js` (đúng 250 dòng): `readFile`/`readForIndex`/`write` và `atomicWriteJob` (qua `prepareSafeWriteTarget` giữ mode) đi qua safe-object-open. `readForIndex` giữ ngữ nghĩa ENOENT/FILE_TOO_LARGE/binary.
- Grant model v2 (`execution-file-access.js`): provenance WeakMap, `authorizeCurrent` live, copy/serialize mất provenance → `FILE_ACCESS_POLICY_INVALID`; docs write cần `authorizeDocsWrite`; GOVERNANCE_FILES / workflows / vocabulary / node_modules luôn deny write.
- Post-delivery re-assert (`assertExecutionFileAccess` trước trả kết quả) đã nối đủ ở `sed-lines.js`, `rg-files.js`, `read-code.js`, `claude-file-tools.js`, `engineering-tool-binding.js` (dispatch).

## 3. Không đạt do tồn tại sẵn (out of scope, đối chứng tại HEAD)

Hai test sau FAIL, nhưng đã tái hiện **nguyên vẹn trên HEAD `4ad1035`** qua worktree tạm (đã dọn sạch) với cùng Node v18 → không do change set này gây ra:

1. `tests/unit/file-service.test.js` — "System Engineer can read project node_modules…": thiếu rejection kỳ vọng với `architectureFiles.readForIndex("node_modules/example/index.js")`. Liên quan `assertRoleFileAccess` dependency-read (commit `7803639`, 2026-10-20), không thuộc phạm vi R1/R2 và file không nằm trong diff này.
2. `tests/unit/engineering-tool-catalog.test.js` — "System Engineer uses all twelve shared schemas…": catalog có thêm `delete_file` (13 tên) trong khi test vẫn đối chiếu 12. cũng tồn tại tại HEAD.
Không sửa hai test/code này trong đợt này vì nằm ngoài phạm vi kế hoạch; cần owner/AM phân loại trước.

## 4. Mapping R1–R6 → O1–O6 / F1–F5 / C1–C6 (theo §5 và §3.3 của kế hoạch)

| R | Mapping | Trạng thái đợt này | Evidence |
|---|---|---|---|
| R1 | C2; O1/O3/O5; F1/F5 | **PASS (deny+allow controls, integration-level)** | §2.1 R1 bảng; `safe-object-open.js`; race test 1 |
| R2 | C2; O1/O3/O5; F5 | **PASS phạm vi đọc/ghi đã chốt; một phần thu hồi chờ §3.1** | §2.1 R2 bảng; race test 2 |
| R3 | C3/C4; O3/O4/O5/O6; F1/F2 | **BLOCKED-by-policy (giữ khóa, đúng guardrail)** | policy test `run_check` → TOOL_LOCKED; `reviewer-forge-tools` isolation unsupported giữ nguyên |
| R4 | C5; O1/O2/O5; F3/F4/F5 | **PARTIAL** — composition đọc/recovery đã kiểm chứng; docs-write classification là quyền owner | runtime-tool-governance PASS trong batch 74/74 |
| R5 | C1/C5; O1/O2/O5 | **NOT RUN / NOT CERTIFIED** — không có Node >=22.5.0 trong sandbox | §1; §6 |
| R6 | C6; cần R1–R5 + §3.1 | **BLOCKED** — không tự chốt authority, không bật route cho smoke | guardrail §2–§3.2 của plan |

Lưu ý trung thực: "PASS" ở R1/R2 nghĩa là **boundary và deny controls hoạt động ở tầng kiểm chứng được**; nó không phải chứng nhận rollout provider (R5) hay quyết định authority (R6). Deny ≠ PASS toàn phần; `REVIEW_CHECK_ISOLATION_UNSUPPORTED` ≠ verification pass.

## 5. NOT RUN / BLOCKED (tách riêng)

- Integration re-run Node `>=22.5.0` (R5): NOT RUN — runtime không khả dụng trong sandbox này; cần môi trường owner cấp.
- Matrix provider×mode×fresh/resume/restart: NOT CERTIFIED — không suy từ shared definitions.
- Smoke v2 coding→verification→independent review (R6): NOT RUN — chặn tới khi §3.1 chốt.
- Mở route verification/reviewer subprocess (R3): KHÔNG thực hiện — cần bằng chứng isolation trước.
- Full project suite: không chạy theo chỉ đạo ("only relevant tests"); danh sách suite đã chạy ở §2.2.
- Git commit/push: chưa thực hiện (chờ owner).

## 6. SHA-256 working tree của các file trong scope

```
bcc67e52bd732fae9fb64b3b254f1e8db8437d5d418693badf094667e332266b  backend/src/infrastructure/filesystem/safe-object-open.js
08ef89105d70802feeadbad86ad83b4351ef223d8f695f1eec422fee657c7d64  backend/src/infrastructure/filesystem/file-service.js
d903e76d65d4407657e5e7c9425f06eda30d9658aa00b9d26c648146736ee222  backend/src/tools/execution-file-access.js
15372f9bc73c23524d6a45367e6ea9466cb0a950a7d56db4a387cac2e523afdb  backend/src/tools/tool-authorization.js
73af2fdf65117e90fe91e964ecee90f9aed3b3e5b2f4c5ee878647159fc7ca11  backend/src/tools/engineering-tool-binding.js
1ce2cfb97e19cd2a2309946c77f576c35a46c9512bfff63dbdc99fe98afd9520  backend/src/tools/agent-lifecycle-tools.js
903e346b879f8dbe2d43400494b1a84351e2a642ae399f51f2f2079bbb80a87a  backend/src/tools/claude-file-tools.js
46ce0041f3b4ff8fdf3e8945527644818cd0c1abf0fff4706470d8d4c933f8a4  backend/src/tools/read-code.js
f06795d18a0e32587bd56b089709be76b4b925e72661c61c16f2b176ad504411  backend/src/tools/rg-files.js
efafc91c78051fd61dbcaa3ae620f28b50036ce00e09b7a805a01c4006e667da  backend/src/tools/rg-search.js
3a1c056f6416da892741b67a604401bc68f6442817cce58ca1dd7348ac5360c1  backend/src/tools/sed-lines.js
547548d40329a29f53522012c41944848d26ec420eef58e388ea5f7c806caf99  backend/src/tools/search-code.js
3aa384ad3bfde7c542eac98d3b73427d862c7a41eb6c03db6e8f41b38102ad6b  backend/src/tools/select-code-graph-candidates.js
314388a59fcec0b5a198a0cda7e0d0fe506ce350081271ac752bc2f0539d0d36  backend/src/tools/agent-file-index-view.js
f83f65a9fc4ff69fb47281fa3b49ccead47fc8f1df72502ea1d794038ad61d1f  backend/src/tools/engineering-tool-implementations.js
cd4c2732f5645009ad317aec6e74fe1390439a9ff0cf9351da981632a0c9db2e  backend/src/modules/governance/runtime-tool-governance.js
934aba151ccf1485bfba62082b234108f450d4e110153b9f205e605d6b2d89d7  backend/src/modules/supervisor/nodeforge-task-executors.js
943d4cc7f7e91cb4b8a31d8b4b0c254b0237467654479bf1beef01e5e7d88481  backend/src/modules/supervisor/nodeforge-task-prompts.js
6cc9d892e23b83f6f33f422a41b474cbb6817eb04335a78f677ecc938fec4df3  backend/src/modules/supervisor/review-worker.js
bdcbf7eda172562c91020e37f6053bfdd94d15c3793aa14b2f6d1dcad21a5593  backend/src/modules/supervisor/reviewer-committed-source.js
4e83b2a6a6b43d3daf16f0e16d7278c45fc8e1b2bb1d98b70a66563e9a4cd413  backend/src/modules/supervisor/reviewer-forge-tools.js
c1825e24e893120d88ca633ff3bdf1a77dddd2b5136db3f6530b8a8a05345d91  backend/src/modules/supervisor/reviewer-snapshot-tools.js
d08a83ad3cf915944ef20dc894919ddf01fa4c0f7cff31a7a8f8bc4a6bce0fe6  backend/src/modules/supervisor/ticket-verification-environment.js
b299c09cfdedb754722b98b37b558e1b3b15e26eab9bfcc53c4d97f91e5c8b74  backend/src/modules/supervisor/ticket-verification-materialization.js
6c97fe83eff620a9bf982ac193de37fef066a8ee2e064fb1a12d6104ae773672  backend/tests/unit/execution-file-access-race.test.js
de81d559e902d289dbf11bcd19323da82e881c8a47b6a40ac84e71d6b3f83bf5  backend/tests/unit/execution-file-access-policy.test.js
901c3bd1537d186179a4be6b2472ad9289a647e5ab3e6b2f558c50497fff0e9b  backend/tests/unit/execution-file-access-discovery.test.js
2bb198493aa93196faa9b794e616f6d435f827787675cbad2b3996c00e0a4563  backend/tests/unit/reviewer-snapshot-discovery.test.js
2e4aac1ba0e6b4f696b6ce555a441074d1c5f11d0de9dad6e6f0465268a71c79  backend/tests/unit/verification-environment-boundary.test.js
9cce1c411973bfd20c7f4a9f23d8714beaabf1c5cafac705043f228d58f5dc1d  backend/tests/unit/coder-path-permissions.test.js
4cc76f8f2103cf203c4ba813178eacd0539b5b94f768f776bb823491bc159069  backend/tests/unit/coder-reviewer-capabilities.test.js
395b3c0363b7cd0ea45cca5d3510b7e3669262a7e7ff239df8b37df0837ebe1c  backend/tests/unit/engineering-tool-binding.test.js
c26ece746ea5596e47e605a466b4155575b5c0e8d1bb9f4fa626fcdd09968c3c  backend/tests/unit/review-worker.test.js
bf8b9f3ca6cfd1636aee918dd9242746c5a26f7ca85d42260c658a6a5a0967e6  backend/tests/unit/reviewer-forge-tools.test.js
170845716a4fab049314437bce202e2048b1b540a4c1d045561ff337f2c87461  backend/tests/tools/rg-search.test.js
```

File ngoài diff nhưng liên quan bối cảnh (không sửa trong đợt này): `file-service-role-policy.js` (baseline `7803639`), `dependency-read.js` (baseline `7803639`).

## 7. Việc còn lại (đề xuất bàn giao tiếp)

1. Owner chốt hai quyết định §3.1 (semantics thu hồi + phân loại docs-write) → mở khóa R2-đầy-đủ và R4-đầy-đủ.
2. Chủ trì môi trường Node `>=22.5.0` để chạy integration re-run + matrix R5 (hiện NOT CERTIFIED).
3. Bằng chứng isolation subprocess cho R3 (workspace cô lập, provenance artifact, no live fallback) rồi mới xét mở `run_check`/`run_review_check`.
4. Xử lý hai fail tồn tại sẵn (§3) — cần phân loại của AM vì nằm ngoài phạm vi kế hoạch này.
5. Reviewer độc lập review change set này cùng revision; sau đó mới xét R6 smoke/rollout.

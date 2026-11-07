# AM Review: Báo cáo triển khai Cập nhật System Prompts, Role READMEs & Ticket Runtime (`subagent-prompt-readme-update-se-report.md`)

- **Ngày review:** 2026-11-07
- **Người review:** Architecture Manager (AM)
- **Tài liệu kế hoạch gốc:** `docs/architecture/subagent-prompt-readme-update-plan.md` (`sha256:687eaae80f6ed94231315949ce2356c4aa10b37eed21426d782cf75e7006a0e6`)
- **Báo cáo SE được kiểm tra:** `docs/architecture/subagent-prompt-readme-update-se-report.md` (`sha256:73a6fe6d29c63909d80a83d52513fb1245f56cfe0c6dc81f5f9aca23c309a3b4`)
- **Kết luận nghiệm thu:** **`PASS`**

---

## 1. Bảng đối chiếu bằng chứng (Evidence Verification)

| # | Hạng mục trong kế hoạch | File & SHA-256 kiểm tra thực tế | Kết quả kiểm tra | Kết luận |
|---|---|---|---|---|
| **1** | Cập nhật cả 5 file Role README (`workflows/agents/*/README.md` $\le 250$ dòng) với quy tắc phối hợp song song (Parallel Co-Execution) | - `workflows/agents/coder/README.md` (`sha256:861db92b80a465635f88ab31f92faa1a76b7c6fd2475fae739f0619b43cf4071`, 55 dòng)<br>- `workflows/agents/architecture/README.md` (`sha256:b87fa79774c7aeb160906f58faaf0d7ef939e0696370d284fa9fc268f23dbb5c`, 132 dòng)<br>- `workflows/agents/system-engineer/README.md` (`sha256:633125171183caccffdc73b90877cd9166989de209094f56e3d2b43f2e99ac1c`, 23 dòng)<br>- `workflows/agents/reviewer/README.md` (`sha256:6584967d389dce152eecdcc70afe49142b85d3193122ee5b392477e9507f441f`, 58 dòng)<br>- `workflows/agents/sprint-leader/README.md` (`sha256:7fae7e083d3f87bb4fc753f9921461c154b5f9133eb62147ce8903f9ff548f3e`, 156 dòng) | Cả 5 file đều có hướng dẫn gọi `delegate_subagent({tasks:[{id,objective,paths}]})` (tối đa 3 task read-only song song) cùng lúc với việc Agent Cha trực tiếp đọc/sửa file mục tiêu chính, và tận dụng `observed_files` (`read_file` metadata receipts + `sha256` checksums). | **ĐẠT (`PASS`)** |
| **2** | Cập nhật `fileToolInstruction` & `sourceDiscoveryInstruction` trong `owner-sdk-stream.js` | `backend/src/application/owner-sdk-stream.js` (`sha256:05b0f41c319072ea490e8e6b23a7b11c7ad7d9c32606b1ec908afa8421ec02ba`, dòng 147–151) | Đã bổ sung hướng dẫn gọi `delegate_subagent({tasks:[{id,objective,paths}]})` song song cùng lượt với `read_file`/`Read`/`edit_diff` trên file chính cho SE, AM (chat & planning), SL, Coder, RV, kèm hướng dẫn tái sử dụng `observed_files` receipts. | **ĐẠT (`PASS`)** |
| **3** | Cập nhật prompt của Coder, SL, Reviewer, Blocker Recovery trong Ticket/Sprint Runtime | - `backend/src/modules/supervisor/nodeforge-task-prompts.js` (`sha256:ada6a016eda00304e0da03f01babf2ca45d473051af55de2211699361ca63842`, dòng 28, 57, 129, 158)<br>- `backend/src/application/sprint-plan-leader.js`<br>- `backend/src/application/ticket-sprint-leader.js`<br>- `backend/src/modules/supervisor/review/review-worker.js`<br>- `backend/src/modules/supervisor/blocker/blocker-recovery-agent.js` | Cả `buildCodexTicketPrompt` và `buildToolTicketPrompt` đều thêm `delegate_subagent` vào danh sách canonical tools và hướng dẫn phối hợp song song + tái sử dụng `observed_files`. Các prompt của SL, RV và Blocker Recovery đều đã được đồng bộ. | **ĐẠT (`PASS`)** |
| **4** | Nối `childExecutor` và đồng bộ `observed_files` $\rightarrow$ `readCache` cho Coder trong Ticket Runtime | - `backend/src/modules/supervisor/nodeforge-task-executors.js` (`sha256:d6158f0cae6f47abe6837da2dc36f2642ec5f721d29c2b262d957282494494e3`, dòng 62–72, 85–89, 151–160)<br>- `backend/src/tools/engineering-tool-binding.js` (`sha256:05871bd23ec8ddb6b247a109521e1421ac2fd93854bd4193e1f9f9da4b87401b`, dòng 40–46)<br>- `backend/src/modules/supervisor/ticket/ticket-resume.js` (`sha256:e1abfec7be1e029f12182931be6aee7726fe5e2e31e3401820fd63020166a784`, dòng 118–120) | - `runToolTicket` (Claude) và `runCodexTask` (Codex) đều có `childExecutor` mặc định chỉ cấp 5 tool read-only (`search_tree`, `list_files`, `search_text`, `read_file`, `Read`).<br>- Đã sửa lỗi lọc nhầm `mcp__forge__Read` khỏi `allowedTools` của Coder trên Claude SDK (dòng 87).<br>- Khi `delegate_subagent` trả về `observed_files`, cả `context.observed_files` và `state.readCache` (`rememberRead`) đều được cập nhật tự động. | **ĐẠT (`PASS`)** |
| **5** | Chạy kiểm thử xác nhận (`run_check`) | - `backend/tests/unit/owner-source-discovery-prompt.test.js` (`sha256:732b0fcefc3b463af488760989076c604c55ed4cf5e80275de39cc0ae40baeb7`)<br>- `backend/tests/unit/coder-unified-forge-tools.test.js` (`sha256:635fc0c31df8c7255fc8aaa75ea1c0a08448906865c20280a0dfe084cdec367b`)<br>- Cùng 8 file test liên quan | Tất cả 10 bộ unit test đều `PASSED` (`exit_code: 0`, Run ID: `VERIFY-RUN-923e44aa-6a2e-4626-8c41-8ee26eb28291`). | **ĐẠT (`PASS`)** |

---

## 2. Kết luận của Architecture Manager

**`[VERDICT: PASS]`** — Toàn bộ hạng mục trong `docs/architecture/subagent-prompt-readme-update-plan.md` đã được triển khai đầy đủ, chính xác và vượt qua toàn bộ bài test kiểm chứng.

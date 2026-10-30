<!-- Báo cáo thực thi B.3 dành cho Owner và AM, phân biệt di chuyển source, receipt kiểm tra thực tế và quyết định đối chiếu còn mở; giữ nguyên lỗi tồn đọng thay vì sửa assertion hoặc policy ngoài phạm vi. -->
# Tiến độ B.3 — tái cấu trúc supervisor

Ngày: 2026-10-29. Người nhận: Owner và AM.

**ĐÃ NGHIỆM THU TOÀN BỘ BƯỚC B.3 (`B.3.1`–`B.3.6`) VÀ ĐÓNG NGHIỆM THU PHẦN B (`PASS` — Owner & AM ký nhận ngày 2026-10-30).** Xem [báo cáo tổng kết Phần B](se-phase-b-final-report.md).

## Quyết định kỹ thuật của AM sau báo cáo B.3.1–B.3.5 (2026-10-29)

1. **Nghiệm thu các đợt B.3.1 (`browser/`), B.3.2 (`coder/`), B.3.3 (`blocker/`), B.3.4 (`review/`) và B.3.5 (`ticket/`) (`PASS`):**
   - Toàn bộ 222 module trong 5 miền đã được di chuyển đúng kiến trúc, xóa xong `backend/src/modules/agents/.gitkeep` (`01ba4719...`), cập nhật `STRUCTURE.md`, bổ sung sửa 3 consumer UI bị sót từ B.3.1 (`VERIFY-RUN-e8e41b0a-b5c5-4810-99ec-0fe5e024d611`) và tách `blocker-decision-authority.test.js` (`243` + `35` `code_lines`) đạt chuẩn $\le 250$ `code_lines`.
   - Các cổng kiểm tra dùng chung sau B.3.5 đều đạt: Typecheck (`VERIFY-RUN-c8443b58-36ac-40a8-8b23-a74fba4ffcf4`), Schema (`VERIFY-RUN-f7bc99a1-ca1d-4aff-b017-f04167a6bf9b`), Smoke/Bootstrap (`VERIFY-RUN-e11fe785-5e41-4888-bd9d-809295de062c`), Security comparison (`VERIFY-RUN-c5292ce1-7216-4205-9b97-798442e86229`), UI production build (`VERIFY-RUN-a63b81ce-0f9b-4cea-ba2b-46b16737421c`), Lint 51 batch + UI consumers (`VERIFY-RUN-698970e1-0d15-4ead-a870-62b7d6c51b44`), và Retrieval Benchmark sau B.3.5 (`VERIFY-RUN-6f0f045a-5484-4f86-8e7e-6abab27ffe0c`, `11/11` khớp 100% với baseline).
2. **Quyết định đóng cổng attribution B.3.5 cho 6 case trong `ticket-persistent-occupancy-recovery.test.js` (`PASS`):**
   - Trong `ticket-persistent-occupancy-recovery.test.js`, dòng 60 đang thực thi `assert.deepEqual(result.source_identities, EXPECTED_SOURCES)` với SHA lịch sử cố định của `production-runtime.js` (`95108566...`).
   - Trước B.3.5, `production-runtime.js` trên working tree đã mang SHA `f89f509e...` (do các đợt di chuyển B.1–B.3.4 trước đó cập nhật import), khiến cả 6 case đều dừng ngay tại dòng 60. Sau B.3.5, `production-runtime.js` đổi sang SHA `b126f142...` **chỉ vì đúng 5 dòng import `ticket-*` được chuyển sang `./ticket/ticket-*`** (đã chứng minh tại `.forge/runtime/reports/phase-b3-5-occupancy-source-delta.json`).
   - Cùng environment SHA (`3f8591ae...`), cùng assertion hash (`f6ee087b...`), cùng 6 tên case fail tại đúng một vị trí duy nhất (dòng 60), và khác biệt nội dung diagnostic giữa 2 cây chỉ là chuỗi SHA thực tế của `production-runtime.js` (`f89f509e...` vs `b126f142...`) sinh ra trực tiếp từ việc đổi đường dẫn import của B.3.5.
   - **Quyết định của AM:** **Chấp thuận hoàn toàn attribution cho 6 case occupancy của B.3.5 (`PASS`)** dựa trên bằng chứng delta source chỉ đổi 5 dòng import, giữ nguyên SHA/diagnostic gốc trong `.forge/runtime/reports/phase-b3-5-occupancy-and-lifecycle-strict.json` và không sửa expected hash lịch sử trong `ticket-persistent-occupancy-recovery.test.js`. Cho phép SE chuẩn hóa chuỗi SHA thực tế của file chỉ đổi import (`f89f509e...` $\rightarrow$ `<import-updated-sha>` hoặc tương đương trong bộ so sánh diagnostic khi cần chạy lại script đối chiếu) trong khi vẫn lưu nguyên SHA gốc vào file evidence JSON.
3. **Chỉ đạo thực thi Đợt cuối B.3.6 và đóng Phần B:**
   - **Về bố cục B.3.6:** Hiện tại 39 file còn lại ở gốc `backend/src/modules/supervisor/` đều là các module điều phối lõi, queues, workers, event/signal/status/result buses, namespace runner và task executors (`production-runtime.js`, `supervisor-manager.js`, `supervisor-loop.js`, `supervisor-runtime.js`, `supervisor-adapter-registry.js`, `durable-queue.js`, `sender-worker.js`, `collector-worker.js`, `verification-worker.js`, v.v.). Theo đúng Mục 4.6 của `docs/se-phase-b-source-restructuring-handoff.md`, **cho phép SE giữ nguyên nhóm điều phối lõi này ở gốc `backend/src/modules/supervisor/`** (không bắt buộc tạo thêm thư mục con `runtime/` làm đổi tiếp SHA của `production-runtime.js` và hàng loạt import), chỉ cần thực hiện kiểm toán dependency/cycle, kiểm tra giới hạn $\le 250$ `code_lines` và chạy bộ test điều phối lõi theo nguyên tắc No-New-Failure Attribution.
   - Sau khi hoàn tất kiểm toán B.3.6: cập nhật dòng trạng thái trong `STRUCTURE.md` (bỏ câu *"B.3.5 attribution is still open; B.3.6 has not started"*), xác nhận lại các cổng cuối (lint/typecheck/schema/smoke/UI build/Retrieval nếu có bất kỳ file nào thay đổi sau B.3.5) và ghi báo cáo tổng kết nghiệm thu Phần B vào `docs/se-repo-restructuring-progress.md`.

## B.3.6 hoàn tất — SE đề nghị nghiệm thu Phần B (2026-10-29)

- Giữ nguyên checksum **39 file core** ở gốc supervisor theo quyết định AM. Kiểm toán AST 625 module: **835 cạnh supervisor khớp trước/sau, không thiếu local import/resource cố định và không có cycle mới**; hai nhóm cycle sẵn có được giữ nguyên. Receipt `VERIFY-RUN-411d52f0-3f8e-426b-a5d7-54e2893ddfbd`.
- **74 file test core đạt No-New-Failure Attribution**: 61 khối diagnostic trên 20 file giống nhau trước/sau, cùng hash assertion và environment. Raw test vẫn còn lỗi tồn đọng; không sửa assertion/policy/expected hash. Batch sprint timeout ở một cây đã tách chạy lại không đổi source và PASS cả hai; receipt lỗi ban đầu được giữ.
- Cổng cuối lint, typecheck, schema, smoke/bootstrap, security, production build và **65 file UI trong sáu nhóm** đều PASS. Retrieval cuối PASS `VERIFY-RUN-8f137539-a254-4bcc-98ec-dce302464fd7`, đủ **11/11 case khớp 100% baseline**, hub 0/11. Xác thực evidence PASS `VERIFY-RUN-74ec58cf-3e84-4ef5-9738-242d6abda04c`.
- Đã đồng bộ `STRUCTURE.md`, bổ sung B.3.6 vào inventory và lưu snapshot/checksum/evidence. Không đổi byte production core trong B.3.6.
- **Đề nghị Owner & AM nghiệm thu toàn bộ Phần B.** [Báo cáo tổng kết, receipt đầy đủ và giới hạn](se-phase-b-final-report.md); [evidence cuối](../.forge/runtime/reports/phase-b3-6-final-evidence.json); [các lệnh/receipt đã chạy](../.forge/runtime/reports/phase-b3-6-completed-checks.json).
- Phần B đã hoàn tất kỹ thuật; chưa tự ghi trạng thái Owner/AM đã ký toàn bộ Phần B. Các mục phía dưới giữ lịch sử, gồm các câu attribution còn mở trước quyết định AM. Chưa commit/push hoặc restart API.

Thực hiện theo [handoff Phần B](se-phase-b-source-restructuring-handoff.md). Quyết định nghiệm thu B.0–B.2 của Owner/AM được giữ nguyên trong [báo cáo chung](se-repo-restructuring-progress.md).

## Thay đổi và inventory

| Đợt | Thư mục đích dưới supervisor | Module thực tế | File source/consumer trong snapshot đợt | Kết quả |
| --- | --- | ---: | ---: | --- |
| B.3.1 | browser/ | 14 | 29 | Diagnostic PASS; bổ sung sửa 3 consumer UI bị sót |
| B.3.2 | coder/ | 14 | 40 | Diagnostic PASS |
| B.3.3 | blocker/ | 75 | 175 | 6 batch diagnostic PASS |
| B.3.4 | review/ | 44 | 143 | 5 batch diagnostic PASS |
| B.3.5 | ticket/ | 75 | 259 | Các batch khác đạt; 6 case occupancy chưa chốt attribution |

Tổng cộng **222 module** được chuyển. Số thực tế khác ước lượng của handoff; không tạo module hay re-export để khớp số dự kiến. Các số consumer có chồng lặp giữa các đợt, không cộng thành số file duy nhất.

- [Inventory source → target, SHA trước mỗi đợt và các amendment](../.forge/runtime/reports/phase-b3-source-inventory.json).
- Snapshot giữ byte nguồn trước từng đợt: `phase-b3-1-before.json`; `phase-b3-2-before-01.json` tới `09.json`, phần cuối tên `phase-b3-2-before-010.json`; B.3.3 gồm 28 phần, B.3.4 gồm 22 phần, B.3.5 gồm 38 phần. Tất cả nằm trong `.forge/runtime/reports/`.
- SHA trong inventory là **SHA trước đợt**, không phải SHA cuối sau khi import của các đợt sau tiếp tục đổi. Snapshot và amendment phải được giữ cùng nhau để hoàn nguyên riêng từng cụm.
- Đã xóa `backend/src/modules/agents/.gitkeep` bằng Forge sau khi quyền đã được nạp. SHA trước xóa: `01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b`.
- Giữ nguyên neo `backend/src/agents/agent-contract.js`; không di chuyển implementation `tools/execution-file-access.js`.
- Core như `production-runtime.js`, queue, supervisor manager/loop và adapter registry hiện vẫn ở gốc. Chưa coi đó là kết quả kiểm toán B.3.6.
- Đã cập nhật [STRUCTURE.md](../STRUCTURE.md) theo bố cục thực tế.

## Kiểm chứng theo cụm

**Diagnostic PASS chỉ có nghĩa là đối chiếu không phát sinh lỗi mới trong phạm vi đã đo; không biến các raw test fail thành test xanh.**

- B.3.1: `VERIFY-RUN-f960f9ac-c4de-41bc-ad42-099a70ff58c0`; giữ hai lỗi browser-verification tồn tại ở cả hai cây.
- B.3.2: `VERIFY-RUN-0d1aa809-750d-4e7f-891e-663d08836594`.
- B.3.3: lượt gom 89 file `VERIFY-RUN-eadc27ce-ca2e-44e0-9db2-d1d0cd74e849` FAIL do TAP không hoàn tất. Chia thành 6 batch đối chiếu, cả 6 PASS; giữ receipt lỗi ban đầu.
- B.3.4: 5 batch đối chiếu PASS.
- B.3.5: batch 1–8, batch 11, phần còn lại của batch 9 và các phần đã cô lập của batch 10 PASS. Batch 9 từng lỗi vì đường dẫn gián tiếp bị sót; đã sửa đường dẫn đọc source, giữ assertion. Batch 10 có `FILE_ACCESS_UNSAFE_PATH` xuất hiện khác case giữa hai lượt; các test liên quan và phần còn lại đều đã PASS khi cô lập. Chưa quy kết nguyên nhân runtime hoặc sửa policy.
- Evidence/receipt: [B.3.1–B.3.3](../.forge/runtime/reports/phase-b3-first-three-gates.json), [B.3.4](../.forge/runtime/reports/phase-b3-4-gates.json), [B.3.5 và cổng hiện tại](../.forge/runtime/reports/phase-b3-current-gates.json).
- Diagnostic dùng snapshot đúng checksum ngay trước từng đợt, cùng environment cho hai cây, giữ hash assertion sau chuẩn hóa đường dẫn và diagnostic đầy đủ. Không thay expected hash hay assertion quyền để ép xanh.

### Giới hạn 250 code_lines

File test hiện hữu `blocker-decision-authority.test.js` có 271 code_lines khi đụng tới. Đã chuyển nguyên 3 test body sang `blocker-architecture-identity.test.js`, giữ nguyên assertion. File cũ còn **243**, file mới **35** code_lines. [Evidence tách test](../.forge/runtime/reports/phase-b3-3-test-split.json).

Lượt test hẹp sau tách `VERIFY-RUN-f3707a5e-8443-4033-80a4-944c15f23af7` vẫn FAIL một case AM authority (expected 2 invocations, actual 1); diagnostic B.3.3 batch 5 đã ghi cùng lỗi trước/sau di chuyển. Ba test được tách không lỗi. Không sửa logic runtime ngoài phạm vi.

Lint 51 batch theo 5 đợt đều PASS (3 + 3 + 14 + 11 + 20), cùng lint bổ sung cho 3 consumer UI. Số code_lines 271 trong inventory là quan sát snapshot trước khi tách, không phải kích thước hiện tại.

## UI và các cổng dùng chung đã chạy

| Cổng | Kết quả thực tế | Receipt |
| --- | --- | --- |
| Typecheck | PASS | VERIFY-RUN-c8443b58-36ac-40a8-8b23-a74fba4ffcf4 |
| Schema | PASS | VERIFY-RUN-f7bc99a1-ca1d-4aff-b017-f04167a6bf9b |
| Smoke/bootstrap bằng entrypoint | PASS | VERIFY-RUN-e11fe785-5e41-4888-bd9d-809295de062c |
| Security comparison | PASS | VERIFY-RUN-c5292ce1-7216-4205-9b97-798442e86229 |
| UI production build | PASS | VERIFY-RUN-a63b81ce-0f9b-4cea-ba2b-46b16737421c |
| Chromium 3 file sau sửa import, chạy tuần tự | PASS | VERIFY-RUN-e8e41b0a-b5c5-4810-99ec-0fe5e024d611 |
| Lint 3 consumer UI | PASS | VERIFY-RUN-698970e1-0d15-4ead-a870-62b7d6c51b44 |
| Retrieval trên trạng thái sau B.3.5 | PASS, 11/11 khớp baseline | VERIFY-RUN-6f0f045a-5484-4f86-8e7e-6abab27ffe0c |

Lệnh smoke thực chạy là `node --test backend/scripts/bootstrap-smoke.mjs`, không ghi nhận `pnpm bootstrap:smoke` đã được chạy.

Bộ **65 file UI** chạy trong 4 batch: 3 batch PASS; batch 18 file còn lại FAIL vì 2 test Ideas import đường dẫn browser cũ. Đã sửa hai file đó cùng dynamic import trong `project-lifecycle.browser.mjs`. Đây là consumer **bị sót từ B.3.1**, không phải lỗi cũ được miễn theo B.3.5. [Evidence sửa import](../.forge/runtime/reports/phase-b3-ui-import-correction.json).

Receipt UI ban đầu: `VERIFY-RUN-98b62fa0-9cf1-4858-b562-c899b30a48ff`, `VERIFY-RUN-ff75e88f-74db-45e0-b7f9-c6b61f898e41`, `VERIFY-RUN-af2d30e9-bdf8-4f8f-ba08-910d5608220f` (FAIL), `VERIFY-RUN-852dd29d-2ac6-46c8-8842-ae4c61043593`.

Sau sửa import, chạy 3 file browser song song còn FAIL lifecycle tại `VERIFY-RUN-d6280f25-3056-431e-af55-e6dd3f848116`; chạy lại **không đổi source**, với `--test-concurrency=1`, cả 3 PASS. Lifecycle cũng không fail trong hai cây archive đối chiếu sau đó. Chưa kết luận nguyên nhân lỗi khi chạy song song; giữ receipt thất bại trong evidence.

Build và các static gate đã chạy trước lần bổ sung sửa import test UI; chưa gọi đây là bộ cổng cuối của B.3.6.

### Retrieval

`pnpm --dir backend eval:retrieval` hoàn tất 11/11. So từng case, trường missing, semantic_matches và aggregate với baseline `VERIFY-RUN-ebdb80f6-2834-4614-861c-d7bba84d8192`: **khớp 100%**, bỏ qua thời gian đo.

| Metric | Baseline | Sau B.3.5 |
| --- | ---: | ---: |
| Recall@4 | 0.2121212121212121 | 0.2121212121212121 |
| Precision@4 | 0.13636363636363635 | 0.13636363636363635 |
| Recall@8 | 0.37121212121212127 | 0.37121212121212127 |
| Precision@8 | 0.10227272727272728 | 0.10227272727272728 |
| hub_in_top2 | 0/11 | 0/11 |

Cả 11 case vẫn semantic_matches = 0 như baseline. Không sửa corpus hoặc thêm metric. [Snapshot kết quả và so sánh](../.forge/runtime/reports/phase-b3-5-retrieval-completed.json). Đây là đo trạng thái hiện tại, chưa thay thế benchmark cuối sau B.3.6.

## B.3.5 còn mở: SHA source trong 6 case occupancy

`ticket-persistent-occupancy-recovery.test.js` ghim SHA source lịch sử. Snapshot ngay trước B.3.5 đã FAIL 6 case tại assertion này. Cây sau di chuyển cũng FAIL đúng 6 tên case, hash assertion giữ nguyên; tuy nhiên SHA thực tế của `production-runtime.js` đổi vì **5 dòng import ticket** đổi đường dẫn. Vì vậy diagnostic SHA không còn giống nguyên văn.

- Phép đối chiếu strict vẫn **FAIL**, receipt `VERIFY-RUN-639d1a6f-d5db-4cd7-aaa9-e7b57849d426`.
- SHA actual trước: `f89f509e87bb46f989ca41f4a731c6b9fbdc1bbadd1c8c7c89f5f79903d5fa28`.
- SHA actual sau: `b126f142f6ece3732ad7283cbad82c0125a1be88944d61549c0d737a69cae484`.
- Expected SHA lịch sử của production-runtime vẫn giữ `95108566ff89ac7e543fd70e8f26e08df878cfb56e55f5f23b51abc51c54b1fc`.
- Assertion hash giống nhau: `f6ee087bd93c298087deb323e6662dc97ef86164a03037aa51f7d5775e1cb2b9`.
- Hai cây dùng cùng environment SHA `3f8591aeff9236f1db2e8a5099b86db61d0a6590e1954f41292bb8f21357f2fc`.
- [Diagnostic đầy đủ hai cây](../.forge/runtime/reports/phase-b3-5-occupancy-and-lifecycle-strict.json) và [delta source chỉ 5 import](../.forge/runtime/reports/phase-b3-5-occupancy-source-delta.json).

**Đề nghị Owner/AM quyết định riêng:** có chấp thuận attribution cho 6 case bằng cùng tên lỗi, assertion nguyên vẹn và delta source chỉ đổi import, đồng thời giữ SHA/diagnostic gốc hay không. SE chưa chuẩn hóa bỏ SHA, chưa sửa expected hash, chưa tự áp ngoại lệ này. Assertion hash dừng test trước khi chứng minh đầy đủ hành vi occupancy; không tuyên bố các hành vi phía sau đã đạt.

## Việc tiếp theo và giới hạn bàn giao

1. Chốt cách attribution 6 case occupancy để đóng cổng B.3.5.
2. Sau đó mới B.3.6: kiểm toán điều phối lõi, dependency/cycle và các test core theo snapshot riêng; có thể giữ core tại gốc đúng handoff.
3. Chạy các cổng cuối và Retrieval trên trạng thái hoàn tất B.3.6 trước khi đề nghị nghiệm thu Phần B.
4. Working tree có nhiều thay đổi ngoài phạm vi, gồm 8 staged. Không reset, không stage, không commit/push. `git_diff` vẫn trả `GIT_DIFF_FAILED`; chưa chứng minh đã xem được toàn bộ patch bằng Git diff.
5. Chưa restart backend và chưa có bằng chứng runtime production đã nạp source mới.

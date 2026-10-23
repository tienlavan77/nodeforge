<!-- Kế hoạch hoàn thiện phần kỹ thuật còn lại của file-access policy sau báo cáo continuation; tách công việc độc lập khỏi hai quyết định authority, giữ ranh giới AM/SL và bằng chứng nghiệm thu. -->
# Plan: Remediation quyền truy cập Coder/Reviewer (giai đoạn 3)

**Ngày:** 2026-10-22
**Trạng thái:** Dự thảo kế hoạch hoàn thiện; **không phải** approval, manifest sửa file hay lệnh RUN/dispatch.
**Kế hoạch tiền nhiệm:** `workflows/plan-coder-reviewer-file-access-policy.md` (gốc, O1–O6/F1–F5) và `workflows/plan-coder-reviewer-file-access-policy-continuation.md` (C1–C6). Tài liệu này **không thay thế hay giảm** các outcome đó; nó khoanh phần kỹ thuật còn lại sau báo cáo continuation và cô lập blocker authority.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Báo cáo continuation ghi nhận hardening và deny controls đã cải thiện (đóng `run_review_check` chưa cô lập, siết snapshot validation, evidence snapshot), nhưng vẫn ở trạng thái *triển khai một phần — chưa đủ rollout*, C1–C6 chỉ PARTIAL/BLOCKED/NOT RUN. Khoảng trống thực tế là boundary chống race, cô lập verification/review, composition production/legacy/recovery và bằng chứng end-to-end.
- **Kết quả:** Có ít nhất **một luồng v2 được chứng nhận an toàn thực sự** — Coder đọc dependency/caller ngoài manifest → sửa trong write scope → verification chạy trong authority hợp lệ → Reviewer đọc đúng snapshot độc lập — kèm inventory bằng chứng cho từng route và cơ sở quyết định rollout.
- **Giá trị:** Đóng rủi ro rò scope và tự cấp quyền, cho phép bật verification/review thật thay vì chỉ chặn để lấy PASS.

**Lưu ý baseline:** các con số và kết luận dưới đây lấy từ **báo cáo tự khai**, chưa được kế hoạch này tái kiểm chứng trong code. SE phải đối chiếu revision/HEAD và checksum hiện hành trước khi kế thừa (xem §6).

## 2. Phạm vi

### In scope (phần kỹ thuật **không** bị chặn authority — SE/SL làm được ngay)

- Boundary filesystem ràng buộc **đối tượng thực** được đọc/ghi, chống đổi path/symlink giữa check và use; bao phủ read/write/create/discovery/graph/cache; protected deny luôn thắng grant.
- Cache/index và grant cũ phải chịu **authority hiện hành** trước khi trả tên/snippet/nội dung; test thu hẹp và thu hồi ở boundary thực (không chỉ mock callback).
- **Một** route verification Coder v2 chạy được trong authority hợp lệ với bằng chứng cô lập subprocess/tiến trình con, output/cache/temp và dependency access không thành đường vòng; verification là grant riêng, không suy từ read grant.
- Reviewer checks dùng workspace cô lập, provenance source/dependency/toolchain khớp môi trường artifact; không sửa working tree Coder, không lấy dependency live thay evidence thiếu.
- Production composition cấp `fileAccessPolicy` từ nguồn tin cậy; phân nhánh v2 hợp lệ / legacy có provenance / context không xác định; resume/restart reconcile và phát hành lại, không deserialize checkpoint thành quyền, không nâng grant.
- Chạy lại integration trên Node được hỗ trợ (`>=22.5.0`); hoàn tất provider×mode×fresh/resume/restart matrix; smoke cùng revision; independent review gắn đúng artifact/revision.

### Out of scope

- **Không** bật bất kỳ route nào chỉ để smoke PASS; không giảm tiêu chí O1–O6/F1–F5; không chuyển deny controls thành "hoàn tất toàn provider".
- **Không** cấp project-wide access, shell tùy ý, quyền ghi source cho Reviewer hay ghi governance cho Coder.
- **Không** đổi approval/storage contract, review verdict semantics, ticket/revision đã khóa.
- **Không** mặc định hỗ trợ Codex CLI v2 hay bật native tools; không mở verification trước khi chứng minh isolation.
- **Không** tự chốt hai quyết định authority (§3.1) — đó không phải việc của SE/SL.

## 3. Hướng tiếp cận và guardrails

### 3.1. Hai quyết định authority — vẫn là blocker, tách khỏi phần kỹ thuật

| Vấn đề | Đầu vào cần có từ decision owner | Khi chưa có |
| --- | --- | --- |
| **Nguồn phân loại governance docs** | Policy được duyệt, decision owner, identity/revision/SHA, quy tắc phân loại và xử lý xung đột; Node resolver dùng đúng nguồn đó. | Giữ deny ghi docs chưa phân loại. Không dùng agent/prefix/exact manifest làm authority. **Chỉ chặn phần ghi governance và route phụ thuộc; không chặn R1/R2/R4 discovery.** |
| **Semantics thu hồi quyền khi execution đang chạy** | Nguồn quyết định; thời điểm hiệu lực; hành vi với operation chưa bắt đầu / đang chạy / kết quả chờ trả / side effect đã xảy ra; nghĩa vụ audit/reconcile. | Không tự chọn "tiếp tục quyền cũ", hủy tức thì hay coi callback hiện tại là semantics đã duyệt. Chặn rollout phần phụ thuộc; R2 test thu hồi **tạm thời chỉ phủ boundary đọc/ghi đã chốt**, semantics đầy đủ chờ owner. |

AM đối chiếu policy hiệu lực, chỉ trình owner tradeoff vượt thẩm quyền; không đẩy quyết định security/data semantics cho SE. Hai quyết định này **chưa được chốt** trong các tài liệu đã đọc [E1 §1; E2 §3.1].

### 3.2. Nguyên tắc chứng nhận route (áp dụng cho mọi R)

- **Route-first:** mỗi route được bật phải có allow + deny evidence tương ứng; route chưa chứng minh giữ `unsupported`/deny, ghi rõ giới hạn. Deny ≠ PASS; `REVIEW_CHECK_ISOLATION_UNSUPPORTED` ≠ verification đạt.
- **Không fallback:** khi route chuẩn từ chối, cấm rơi sang legacy service, shell hoặc provider có quyền rộng hơn. Coder admission deny **không** đồng nghĩa Reviewer path được bảo vệ.
- **Boundary thực, không phải giả định:** chống TOCTOU phải chứng minh bằng race test có điều phối, đối chứng allow thường; không coi `lstat` trước thao tác hay hậu kiểm là đủ.
- **Authority tách lớp:** read scope / write scope / verification grant là các grant riêng; không suy grant này từ grant khác.
- **Giữ gate độc lập:** manifest/create grant/budget, commit ledger, push, review gates; đọc caller ngoài manifest không cho phép sửa caller.

### 3.3. Mapping về kế hoạch tiền nhiệm

Outcome R1–R6 dưới đây **không phải** contract bất biến cho SL; chúng gom các khoảng trống còn lại và ánh xạ về C/O/F để chứng minh coverage. SL vẫn tự quyết số ticket, tên, thứ tự, helper, file budget trong guardrails [E3 §3–4].

## 4. Khu vực ảnh hưởng và evidence (chưa tái khảo sát source)

| Mã | Nguồn đã đọc | Giá trị / giới hạn |
| --- | --- | --- |
| E1 | `workflows/report-coder-reviewer-file-access-policy-continuation.md` (92 dòng) | Baseline tự khai cho giai đoạn này: đóng `run_review_check`, snapshot validation, evidence snapshot; C1–C6 PARTIAL/BLOCKED; integration 1 PASS/1 FAIL trên Node `v18.19.1`. SHA-256: `sha256:5974e1e6df68258c7d41111c3350920813551d534d8ef8ad2cac318b18e0957d`. **Không phải independent verification.** |
| E2 | `workflows/plan-coder-reviewer-file-access-policy-continuation.md:1–116` | C1–C6, hai quyết định authority §3.1, guardrails filesystem/verification/composition. SHA-256: `sha256:aa4faae73da320418b75fcb122eb2ee7f4947cc01af8008c572e7b71a2a4459f`. |
| E3 | `workflows/agents/architecture/README.md:1–168` | Ranh giới AM/SL, plan theo outcome, approval/revision/SHA, review độc lập. SHA-256: `sha256:f89a981f59e443a2613252c2d176ae2753b7a848ddfe90f0cabbe8bd111d0443`. |
| E4 | `workflows/plan-coder-reviewer-file-access-policy.md`; `workflows/report-coder-reviewer-file-access-policy.md` | Nền O1–O6/F1–F5 và grant v2/snapshot baseline; 108/108 là con số báo cáo trước, **không kế thừa** làm kết quả mới. |

**Candidate areas từ E1 §4 (SHA working tree, chưa đối chiếu HEAD hiện hành):** `backend/src/modules/supervisor/reviewer-forge-tools.js`, `ticket-verification-environment.js`, `ticket-verification-materialization.js`, `review-worker.js`; thêm `backend/src/tools/execution-file-access.js`, `runtime-tool-governance`, `engineering-tool-binding`, `production-runtime.js` và `backend/tests/integration/ticket-verification-environment.test.js` (danh sách từ báo cáo/index, **không phải manifest** — SE phải xác minh path/consumer hiện hành trước khi chốt).

## 5. Outcomes hoàn thiện và điều kiện nghiệm thu

| Mã | Kết quả | Điều kiện đạt (quan sát được) | Mapping / dependency | Authority |
| --- | --- | --- | --- | --- |
| R1 | Boundary filesystem chống race | Integration race có điều phối đổi path/symlink giữa check↔use trên read/write/create/discovery/graph/cache; allow thường đối chứng; protected deny thắng grant. Nếu nền tảng không bảo đảm, giữ route chặn + mô tả giới hạn (không tuyên bố O3 xong). | C2; O1/O3/O5; F1/F5 | Không bị chặn. |
| R2 | Cache/index & grant cũ chịu authority hiện hành | Test thu hẹp và thu hồi ở boundary thực (không mock callback): nội dung dưới grant cũ không lộ khi authority giảm. | C2; O1/O3/O5; F5 | **Một phần** chờ semantics thu hồi §3.1; phần đọc/ghi đã chốt làm được ngay. |
| R3 | Verification + Reviewer checks cô lập | ≥1 route Coder v2 verification chạy thật trong authority hợp lệ với allow/deny subprocess·dependency·isolation; Reviewer checks dùng workspace cô lập, provenance khớp môi trường artifact, không sửa working tree Coder, không fallback live. | C3/C4; O3/O4/O5/O6; F1/F2 | Không bị chặn (cấm mở trước khi có isolation evidence). |
| R4 | Composition + legacy provenance + recovery | Production wiring lấy `fileAccessPolicy` từ nguồn tin cậy (không từ agent/ticket/checkpoint); phân nhánh v2 / legacy provenance / unknown đúng; resume/restart reconcile, không nâng grant, không khôi phục quyền đã thu hồi; logs ghi operation/role/quyết định/identity, không secret. | C5; O1/O2/O5; F3/F4/F5 | **Phụ thuộc** phân loại governance cho route ghi docs; phần composition/recovery đọc-làm được độc lập. |
| R5 | Provider×mode matrix + re-run integration | Chạy lại integration trên Node `>=22.5.0`; certify matrix role×provider×mode×fresh/resume/restart với allow/deny từng route; provider-live hoặc ghi rõ NOT CERTIFIED, không suy support từ shared definitions. | C1/C5; O1/O2/O5 | Không bị chặn. |
| R6 | Cơ sở quyết định rollout | Smoke v2 coding→verification→independent review đạt với thao tác hợp lệ thật; coverage map đủ O1–O6/F1–F5 + regression + review độc lập cùng revision; liệt kê rõ route chưa hỗ trợ. | C6; **cần R1–R5** | **Chặn** tới khi hai quyết định §3.1 được chốt. |

**Gợi ý delivery (không bắt buộc):** R1 và R5 chạy song song sớm vì không cần authority; R3 là bước giảm rủi ro chính cho luồng end-to-end; R2/R4 phần đọc ghi tiến hành, phần phụ thuộc authority giữ deny; R6 cuối cùng. SL tự chọn số/cách gom ticket, miễn mỗi ticket có boundary + verification + implementation type hợp lệ + mutable-file budget nguyên dương.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Mức | Evidence / giả định | Xử lý |
| --- | --- | --- | --- |
| Baseline code hiện hành khác báo cáo (HEAD vs working tree; integration FAIL trên Node v18) | Major | E1 tự khai, chưa tái kiểm chứng. | SE xác minh revision/HEAD + checksum trước kết luận; chạy lại integration trên Node được hỗ trợ. 108/108 và 34/34 đều là số báo cáo, không phải kết quả mới. |
| Chống race không khả thi trên nền tảng filesystem hiện tại | Major/Blocker R1 | Chưa khảo sát. | Cung cấp options + evidence; nếu chạm system boundary, quay về AM, **không tự mở quyền tạm**. |
| Subprocess isolation chỉ đạt bằng sandbox ngoài (bwrap/unshare) khác kiến trúc Node | Major | E1 ghi probe `unshare`/`bwrap` chỉ là khảo sát host, **không** bật route. | SE chứng minh route thật; AM đánh giá nếu đổi security semantics. |
| Hai quyết định authority chưa chốt | Blocker phần phụ thuộc | E1 §1; E2 §3.1. | AM trình owner bằng identity/revision/SHA + semantics kiểm tra qua Node; SE/SL tiếp tục phần độc lập. |
| Bật verification/review sớm để lấy smoke PASS | Blocker | Guardrail §3.2. | Cấm; unsupported khác PASS. |
| Reviewer Codex CLI native chưa chứng nhận dù Coder đã deny | Major | E1 §3. | Không coi CLI sandbox options/MCP allowlist là đủ; certification riêng. |

## 7. Checklist bàn giao (SL/SE → AM → Reviewer)

- [ ] Xác minh approval/policy identity + baseline HEAD/checksum thực trước khi sửa; lập ticket/manifest theo quyền SL, budget nguyên dương.
- [ ] Map mỗi tiêu chí R1–R6 → O1–O6/F1–F5/C1–C6 → ticket/test/artifact; ghi PASS/FAIL/BLOCKED/NOT RUN, **không** ghi đạt theo số lượng tests.
- [ ] Có unit + integration tại boundary thực, positive + deny controls, race/cache/revocation, provider/recovery matrix, smoke thật.
- [ ] Chạy lại integration trên Node `>=22.5.0` và ghi rõ runtime; không đổi unrelated runtime compat để "xanh hóa".
- [ ] Ghi code commit/revision/checksum, policy identity/revision/SHA, snapshot + verification-environment identity, lệnh/checks, kết quả, baseline failures; không secret.
- [ ] Independent review gắn đúng artifact/revision; tác giả không tự thay Reviewer gate; sửa sau review theo revision/gates hiện hành.
- [ ] Báo cáo đạt / còn chặn / rollout-readiness riêng; route unsupported không tự thành "hoàn tất mọi provider".
- [ ] **Không rollout** tới khi R1–R5 xong và hai quyết định §3.1 được owner chốt qua Node contract. Lưu kế hoạch / lập SP **không** tự approve, RUN hay dispatch.

**Trạng thái lượt viết:** Chỉ đọc E1–E4 và rulebook kiến trúc; **chưa** đối chiếu source, **chưa** chạy tests, **chưa** sửa implementation, **chưa** thay đổi approval. Kế hoạch này **không** xác nhận hai quyết định authority đã được chốt.
